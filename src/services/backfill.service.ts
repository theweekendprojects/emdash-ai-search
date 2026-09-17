/**
 * BackfillService — crash-safe, resumable, cron-drained backfill engine.
 *
 * Lifecycle:
 *   start()        → seed the durable job (queue = selected collections).
 *   processBatch() → each cron tick: claim a LEASE (compare-and-set), index a
 *                    bounded batch (BATCH_SIZE docs), persist progress + renew
 *                    the lease AFTER EACH DOC, advance the cursor, release.
 *   status()/cancel().
 *
 * Crash- & concurrency-safety (v0.7.1 fixes):
 *   - Progress is persisted per-document (counters + intra-page offset), so a
 *     mid-batch crash never re-counts or re-indexes already-done docs on resume.
 *   - The lease is RENEWED after each doc, so a genuinely slow batch can't have
 *     its lease expire out from under it and be double-claimed.
 *   - start() refuses to clobber a running job (unless forced).
 *   - cancel() and every write inside the batch are compare-and-set guarded, so
 *     a cancellation can't be silently overwritten by a finishing batch.
 *   - Content-hash dedup (matching the chunker's extraction surface) skips
 *     unchanged docs cheaply.
 */

import type { Ctx, StorageCollection, ContentItem } from "./host";
import type { SearchBackend } from "./search-backend";
import {
  type BackfillJob,
  type DocState,
  BATCH_SIZE,
  LEASE_MS,
  newJob,
  isLeaseFree,
  isActive,
  contentHash,
  decideDoc,
} from "./backfill-types";

const JOB_ID = "current";

/** Thrown internally to unwind the batch when the lease/CAS is lost or the job
 *  was cancelled by another actor — the batch must stop touching the job. */
class LeaseLostError extends Error {}

export class BackfillService {
  private jobs: StorageCollection<BackfillJob>;
  private docs: StorageCollection<DocState>;

  constructor(
    private ctx: Ctx,
    private backend: SearchBackend,
  ) {
    if (!ctx.content) throw new Error("Backfill: content:read capability missing (ctx.content)");
    this.jobs = ctx.storage.backfill_job as StorageCollection<BackfillJob>;
    this.docs = ctx.storage.doc_state as StorageCollection<DocState>;
  }

  /**
   * Seed a fresh job. Refuses to clobber a job that's still processing unless
   * `force` is set (prevents an accidental double-Start from resetting progress
   * while a worker is mid-batch).
   */
  async start(collections: string[], force = false): Promise<BackfillJob> {
    if (!force) {
      const cur = await this.jobs.get(JOB_ID);
      if (cur && cur.phase === "processing") return cur; // already running — leave it
    }
    const job = newJob(collections, Date.now());
    await this.jobs.put(JOB_ID, job);
    return job;
  }

  /** Cancel via compare-and-set so an in-flight batch can't overwrite it. */
  async cancel(): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const v = await this.jobs.getVersioned(JOB_ID);
      if (!v || v.value.phase !== "processing") return;
      const cancelled: BackfillJob = { ...v.value, phase: "cancelled", leaseUntil: 0, updatedAt: Date.now() };
      const res = await this.jobs.compareAndSet(JOB_ID, v.revision, cancelled);
      if (res.applied) return;
      // else: raced with a batch write — retry
    }
  }

  async status(): Promise<BackfillJob | null> {
    return this.jobs.get(JOB_ID);
  }

  /**
   * Process one bounded batch. No-ops unless there's an active, unleased job.
   * Returns whether the job is done and how many docs were handled this batch.
   */
  async processBatch(): Promise<{ done: boolean; processedThisBatch: number }> {
    const now = Date.now();

    // 1) Claim the lease with compare-and-set (crash-safe; single worker).
    const versioned = await this.jobs.getVersioned(JOB_ID);
    if (!versioned) return { done: true, processedThisBatch: 0 };
    const job = versioned.value;
    if (!isActive(job)) return { done: true, processedThisBatch: 0 };
    if (!isLeaseFree(job, now)) return { done: false, processedThisBatch: 0 }; // another worker holds it

    const leased: BackfillJob = { ...job, leaseUntil: now + LEASE_MS, updatedAt: now };
    const claim = await this.jobs.compareAndSet(JOB_ID, versioned.revision, leased);
    if (!claim.applied) return { done: false, processedThisBatch: 0 }; // lost the race

    // Mutable state carried across the CAS-guarded writes in this batch.
    let state: { job: BackfillJob; revision: string } = { job: leased, revision: claim.revision };
    let handled = 0;

    try {
      const collectionId = state.job.queue[0];
      if (!collectionId) {
        await this.commit(state, (j) => ({ ...j, phase: "done", currentCollection: null }));
        return { done: true, processedThisBatch: 0 };
      }

      // list(collection, options); NO where.status filter here on purpose: we
      // need to SEE unpublished/removed docs to purge them. decideDoc()
      // classifies each item; only published ones are indexed.
      const page = await this.ctx.content!.list(collectionId, {
        limit: BATCH_SIZE,
        cursor: state.job.cursor ?? undefined,
      });

      // Resume within a page after a crash: skip docs already handled last time.
      // ponytail: pageOffset assumes the page is stable across ticks. If content
      // is added/removed mid-backfill the offset could land on a shifted item —
      // harmless because indexing is idempotent and hash-dedup skips unchanged
      // docs, but a shifted doc might be visited a tick late. Acceptable ceiling;
      // a fully stable scan would need snapshot isolation the content API lacks.
      const startAt = state.job.pageOffset ?? 0;
      for (let i = startAt; i < page.items.length && handled < BATCH_SIZE; i++) {
        const item = page.items[i]!;
        const delta = await this.indexOne(collectionId, item);
        handled++;
        // Persist progress + renew lease AFTER each doc (crash-consistent counters,
        // and the lease can't expire mid-batch). CAS-guarded: if we lost the lease
        // or the job was cancelled, this throws and we stop.
        state = await this.commit(state, (j) => ({
          ...j,
          processed: j.processed + delta.processed,
          skipped: j.skipped + delta.skipped,
          removed: j.removed + delta.removed,
          errors: j.errors + delta.errors,
          pageOffset: i + 1, // next resume point within this page
          leaseUntil: Date.now() + LEASE_MS, // renew
        }));
      }

      // Batch finished this page slice. Advance: next page cursor, or next collection.
      const consumedWholePage = startAt + handled >= page.items.length;
      await this.commit(state, (j) => {
        if (page.hasMore && page.cursor && consumedWholePage) {
          return { ...j, cursor: page.cursor, pageOffset: 0 }; // next page
        }
        if (!consumedWholePage) {
          return { ...j, pageOffset: startAt + handled }; // more of this page next tick
        }
        // Whole collection consumed → pop to next collection (or done).
        const rest = j.queue.slice(1);
        return {
          ...j,
          queue: rest,
          currentCollection: rest[0] ?? null,
          cursor: null,
          pageOffset: 0,
          phase: rest.length === 0 ? "done" : "processing",
        };
      });
    } catch (err) {
      if (err instanceof LeaseLostError) {
        // Another actor (cancel, or a re-claim after our lease expired) owns the
        // job now. Stop cleanly; do NOT write over their state.
        return { done: false, processedThisBatch: handled };
      }
      // Real error: record it and release the lease (best-effort, CAS-guarded).
      try {
        await this.commit(state, (j) => ({
          ...j,
          errors: j.errors + 1,
          lastError: err instanceof Error ? err.message : String(err),
          leaseUntil: 0,
        }));
      } catch { /* lease already lost — leave it */ }
      this.ctx.log.error("[backfill] batch failed", { err: String(err) });
      return { done: false, processedThisBatch: handled };
    }

    // Release the lease.
    try {
      await this.commit(state, (j) => ({ ...j, leaseUntil: 0 }));
    } catch { /* lost — fine */ }
    return { done: state.job.phase !== "processing", processedThisBatch: handled };
  }

  /**
   * Compare-and-set the job through a pure transform. Re-reads to detect that we
   * still own the lease / the job is still ours; throws LeaseLostError if not,
   * so a cancellation or a re-claim can't be silently overwritten.
   */
  private async commit(
    state: { job: BackfillJob; revision: string },
    transform: (j: BackfillJob) => BackfillJob,
  ): Promise<{ job: BackfillJob; revision: string }> {
    const next: BackfillJob = { ...transform(state.job), updatedAt: Date.now() };
    const res = await this.jobs.compareAndSet(JOB_ID, state.revision, next);
    if (!res.applied) throw new LeaseLostError("job changed under us");
    return { job: next, revision: res.revision };
  }

  /** Index/skip/remove one document. Returns counter deltas (no shared mutation). */
  private async indexOne(
    collectionId: string,
    item: ContentItem,
  ): Promise<{ processed: number; skipped: number; removed: number; errors: number }> {
    const docId = `${collectionId}:${item.id}`;
    const title = String(item.data?.title ?? item.data?.name ?? "Untitled");
    const isPublished = !item.status || item.status === "published";
    const hash = contentHash(title, item.data ?? {});
    const prior = await this.docs.get(docId);
    const action = decideDoc(prior?.contentHash, hash, isPublished);

    if (action === "skip") return { processed: 0, skipped: 1, removed: 0, errors: 0 };
    if (action === "remove") {
      await this.backend.removeDocument(collectionId, item.id);
      await this.docs.delete(docId);
      return { processed: 0, skipped: 0, removed: 1, errors: 0 };
    }
    await this.backend.indexDocument(collectionId, item.id);
    await this.docs.put(docId, { docId, collectionId, contentId: item.id, contentHash: hash, indexedAt: Date.now() });
    return { processed: 1, skipped: 0, removed: 0, errors: 0 };
  }
}
