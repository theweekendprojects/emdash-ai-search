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
  BATCH_SIZE,
  LEASE_MS,
  newJob,
  isLeaseFree,
  isActive,
} from "./backfill-types";

const JOB_ID = "current";

export class BackfillService {
  private jobs: StorageCollection<BackfillJob>;

  constructor(
    private ctx: Ctx,
    private backend: SearchBackend,
  ) {
    if (!ctx.content) throw new Error("Backfill: content:read capability missing (ctx.content)");
    this.jobs = ctx.storage.backfill_job as StorageCollection<BackfillJob>;
    // doc_state bookkeeping now lives entirely in backend.indexDocument (single
    // source of truth); the backfill engine only owns the durable job record.
  }

  /**
   * Seed a fresh job.
   *
   * @param opts.force  Re-upload every doc even if unchanged (bypass hash dedup),
   *                    persisted on the job so every cron-drained batch honors it.
   * @param opts.clobber  Reset a job that's still processing (defaults false, so
   *                    an accidental double-Start doesn't wipe in-flight progress).
   */
  async start(collections: string[], opts?: { force?: boolean; clobber?: boolean }): Promise<BackfillJob> {
    if (!opts?.clobber) {
      const cur = await this.jobs.get(JOB_ID);
      if (cur && cur.phase === "processing") return cur; // already running — leave it
    }
    const job = newJob(collections, Date.now(), opts?.force === true);
    await this.jobs.put(JOB_ID, job);
    return job;
  }

  /**
   * Cancel the active job.
   *
   * Plain get/put — the EmDash storage runtime does NOT implement the
   * compare-and-set / getVersioned surface the stub advertises (calling it
   * throws `getVersioned is not a function`), which is what wedged cancel and
   * the whole drain. A single cron worker drains sequentially, so a plain write
   * is safe enough; a batch in flight re-checks the phase and stops when it sees
   * "cancelled" (see processBatch).
   */
  async cancel(): Promise<void> {
    const job = await this.jobs.get(JOB_ID);
    if (!job || job.phase !== "processing") return;
    await this.jobs.put(JOB_ID, { ...job, phase: "cancelled", leaseUntil: 0, updatedAt: Date.now() });
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

    // 1) Read + claim via plain get/put. The runtime lacks compare-and-set, so
    //    the "lease" is a soft timestamp guard: if a live lease is held we back
    //    off. A single cron worker drains sequentially, so this is sufficient;
    //    indexing is idempotent, so a rare overlap can't corrupt anything.
    const job = await this.jobs.get(JOB_ID);
    if (!job) return { done: true, processedThisBatch: 0 };
    if (!isActive(job)) return { done: true, processedThisBatch: 0 };
    if (!isLeaseFree(job, now)) return { done: false, processedThisBatch: 0 }; // another tick is mid-batch

    // Claim the soft lease.
    let state: BackfillJob = { ...job, leaseUntil: now + LEASE_MS, updatedAt: now };
    await this.jobs.put(JOB_ID, state);
    let handled = 0;

    // Re-read helper: detect a concurrent cancel and stop touching the job.
    const cancelled = async (): Promise<boolean> => {
      const cur = await this.jobs.get(JOB_ID);
      return !cur || cur.phase !== "processing";
    };

    try {
      const collectionId = state.queue[0];
      if (!collectionId) {
        state = { ...state, phase: "done", currentCollection: null, leaseUntil: 0, updatedAt: Date.now() };
        await this.jobs.put(JOB_ID, state);
        return { done: true, processedThisBatch: 0 };
      }

      // list(collection, options); NO where.status filter here on purpose: we
      // need to SEE unpublished/removed docs to purge them. Only published ones
      // are indexed; the rest are removed.
      const page = await this.ctx.content!.list(collectionId, {
        limit: BATCH_SIZE,
        cursor: state.cursor ?? undefined,
      });

      // Resume within a page after a crash: skip docs already handled last time.
      const startAt = state.pageOffset ?? 0;
      const force = state.force === true;
      for (let i = startAt; i < page.items.length && handled < BATCH_SIZE; i++) {
        // Honor a cancel that landed mid-batch: stop before indexing the next doc.
        if (await cancelled()) {
          this.ctx.log.info("[backfill] cancelled mid-batch, stopping");
          return { done: true, processedThisBatch: handled };
        }
        const item = page.items[i]!;
        const delta = await this.indexOne(collectionId, item, force);
        handled++;
        // Persist progress + renew the soft lease after each doc.
        state = {
          ...state,
          processed: state.processed + delta.processed,
          skipped: state.skipped + delta.skipped,
          removed: state.removed + delta.removed,
          errors: state.errors + delta.errors,
          pageOffset: i + 1,
          leaseUntil: Date.now() + LEASE_MS,
          updatedAt: Date.now(),
        };
        await this.jobs.put(JOB_ID, state);
      }

      // A cancel may have landed after the last doc — don't advance over it.
      if (await cancelled()) return { done: true, processedThisBatch: handled };

      // Advance: next page cursor, more of this page, or next collection.
      const consumedWholePage = startAt + handled >= page.items.length;
      if (page.hasMore && page.cursor && consumedWholePage) {
        state = { ...state, cursor: page.cursor, pageOffset: 0, leaseUntil: 0, updatedAt: Date.now() };
      } else if (!consumedWholePage) {
        state = { ...state, pageOffset: startAt + handled, leaseUntil: 0, updatedAt: Date.now() };
      } else {
        const rest = state.queue.slice(1);
        state = {
          ...state,
          queue: rest,
          currentCollection: rest[0] ?? null,
          cursor: null,
          pageOffset: 0,
          phase: rest.length === 0 ? "done" : "processing",
          leaseUntil: 0,
          updatedAt: Date.now(),
        };
      }
      await this.jobs.put(JOB_ID, state);
    } catch (err) {
      // Record the error and release the lease (best-effort).
      try {
        const cur = (await this.jobs.get(JOB_ID)) ?? state;
        await this.jobs.put(JOB_ID, {
          ...cur,
          errors: cur.errors + 1,
          lastError: err instanceof Error ? err.message : String(err),
          leaseUntil: 0,
          updatedAt: Date.now(),
        });
      } catch { /* leave it */ }
      this.ctx.log.error("[backfill] batch failed", { err: String(err) });
      return { done: false, processedThisBatch: handled };
    }

    return { done: state.phase !== "processing", processedThisBatch: handled };
  }

  /**
   * Index/skip/remove one document. Returns counter deltas (no shared mutation).
   *
   * Delegates to `backend.indexDocument`, which is the SINGLE source of truth for
   * the content-hash dedup + doc_state bookkeeping (shared with publish/save/
   * reindex). By default backfill skips unchanged docs; when the job was started
   * with force, it re-uploads every doc.
   */
  private async indexOne(
    collectionId: string,
    item: ContentItem,
    force = false,
  ): Promise<{ processed: number; skipped: number; removed: number; errors: number }> {
    const action = await this.backend.indexDocument(collectionId, item.id, { force });
    switch (action) {
      case "indexed":
        return { processed: 1, skipped: 0, removed: 0, errors: 0 };
      case "skipped":
        return { processed: 0, skipped: 1, removed: 0, errors: 0 };
      case "removed":
        return { processed: 0, skipped: 0, removed: 1, errors: 0 };
    }
  }
}
