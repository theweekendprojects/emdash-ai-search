/**
 * Backfill job model + PURE decision logic.
 *
 * Architecture: unbounded work (N posts) can't run in one bounded invocation, so
 * backfill is a DURABLE JOB drained in bounded batches by the cron scheduler.
 * State lives in storage (survives isolate death); each batch is idempotent and
 * resumable; a lease prevents two cron ticks from working the same job at once.
 *
 * This file holds only pure types + pure functions (no ctx) so the scheduling
 * decisions are unit-testable. The IO lives in backfill.service.ts.
 */

import { extractIndexableText } from "./chunking.service";

export type BackfillPhase = "idle" | "processing" | "done" | "error" | "cancelled";

export interface BackfillJob {
  /** Fixed id — one job at a time (a singleton record). */
  id: "current";
  phase: BackfillPhase;
  /** Collections still to process (head is the active one). */
  queue: string[];
  /** The active collection (queue head snapshot) for status display. */
  currentCollection: string | null;
  /** ctx.content.list cursor within the active collection; null = start. */
  cursor: string | null;
  /** Resume offset WITHIN the current page (docs already handled after a crash). */
  pageOffset: number;
  /** Counters (cumulative across the whole job). */
  processed: number; // indexed this run
  skipped: number; // unchanged (hash match) — not re-indexed
  removed: number; // no longer published → purged
  errors: number;
  /** Lease: a worker sets leaseUntil to claim the job for a batch. */
  leaseUntil: number; // epoch ms; 0 = free
  startedAt: number;
  updatedAt: number;
  lastError?: string;
}

/** Per-document indexed-state, for hash-skip dedup on re-runs. */
export interface DocState {
  docId: string; // storage key = `${collectionId}:${contentId}`
  collectionId: string;
  contentId: string;
  contentHash: string;
  indexedAt: number;
}

export const BATCH_SIZE = 25; // docs indexed per cron tick — bounded work
export const LEASE_MS = 60_000; // a batch must finish within this or the lease expires

export function newJob(collections: string[], now: number): BackfillJob {
  return {
    id: "current",
    phase: collections.length > 0 ? "processing" : "done",
    queue: [...collections],
    currentCollection: collections[0] ?? null,
    cursor: null,
    pageOffset: 0,
    processed: 0,
    skipped: 0,
    removed: 0,
    errors: 0,
    leaseUntil: 0,
    startedAt: now,
    updatedAt: now,
  };
}

/** Is the job free to claim (not currently leased by a live worker)? */
export function isLeaseFree(job: BackfillJob, now: number): boolean {
  return job.leaseUntil <= now;
}

/** Is there more work to do? */
export function isActive(job: BackfillJob): boolean {
  return job.phase === "processing";
}

/**
 * Compute a stable content hash for dedup. It hashes the EXACT text the chunker
 * would index (title + extractIndexableText, which walks nested objects/arrays),
 * so a change to nested/array content — e.g. a Portable-Text body — changes the
 * hash and is NOT wrongly skipped. (v0.7 bug fix: the old version hashed only
 * top-level string fields and missed nested edits.)
 *
 * ponytail: FNV-1a 32-bit — cheap and collision-safe enough for change detection
 * (not security). Same idea as SonicJS content-hash dedup.
 */
export function contentHash(title: string, data: Record<string, unknown>): string {
  return fnv1a(title + "\u0001" + extractIndexableText(data));
}

/** Decide what to do with one doc given its prior state. Pure. */
export function decideDoc(
  priorHash: string | undefined,
  currentHash: string,
  isPublished: boolean,
): "index" | "skip" | "remove" {
  if (!isPublished) return "remove";
  if (priorHash === currentHash) return "skip";
  return "index";
}

function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
