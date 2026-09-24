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

/**
 * Extract the indexable text surface of a content item (title/body plus any
 * nested/array string content, skipping ids/urls/short strings). `contentHash`
 * hashes exactly this so a change to nested content (e.g. a Portable-Text body)
 * changes the hash and is not wrongly skipped by the backfill dedup.
 *
 * (Relocated here from the old chunking.service when the plugin moved fully to
 * Cloudflare AI Search; it is the only piece of that file still needed.)
 */
/**
 * Field names whose values are structural/media/identifier noise, not prose —
 * never index them. `content`/`body`/`text` etc. are handled explicitly.
 */
const SKIP_KEYS = new Set([
  "id",
  "_key",
  "_type",
  "slug",
  "url",
  "href",
  "image",
  "featured_image",
  "thumbnail",
  "metadata",
  "alt",
  "filename",
  "$media",
  "asset",
  "mark",
  "marks",
  "markdefs",
  "style",
  "listitem",
  "level",
  // Enum-ish presentation/config keys on blocks — values are tokens, not prose
  // (e.g. code `language: "js"`, callout `tone: "info"`, `align`, `variant`).
  "language",
  "lang",
  "tone",
  "variant",
  "align",
  "width",
  "type",
]);

/**
 * String-valued keys that ARE prose and must be collected wherever they appear
 * in the tree — across every Portable Text shape, standard or custom:
 *   - `text`    → spans (paragraph/heading/list/quote), the common case
 *   - `code`    → code blocks (`{_type:"code", code:"...", language}`)
 *   - `caption` → image/figure/embed captions
 *   - `title`   → captions/labels on custom blocks (callout, embed, card)
 * Length-agnostic: a two-word heading or a one-line list item is real content.
 * Anything NOT in this set that is a bare string is only kept by the generic
 * fallback when its KEY is not structural/media noise (see SKIP_KEYS).
 */
const TEXT_KEYS = new Set(["text", "code", "caption", "title", "name", "excerpt", "summary", "description"]);

/**
 * Recursively harvest all prose from ANY value — Portable Text or not — into
 * `push`, WITHOUT assuming a specific block shape. This is what makes the
 * extractor future-proof against new/unknown block types (image-in-the-middle,
 * code blocks, tables, callouts, embeds, arbitrary custom blocks):
 *
 *   - Objects: for each entry, if the KEY is structural/media/identifier noise
 *     (SKIP_KEYS) we skip it entirely; if the key is a known prose key
 *     (TEXT_KEYS) and the value is a string we collect it; otherwise we recurse
 *     so nested `children`, `rows`, `cells`, `body`, custom fields, etc. are all
 *     visited. We do NOT special-case `_type === "block"`, so a `code` block or
 *     a table cell contributes its text just like a paragraph does.
 *   - Arrays: recurse into every element (blocks, spans, rows…).
 *   - Strings reached under a non-noise key: kept (URLs excluded).
 *
 * Media stays out because its carrier keys (`image`, `asset`, `$media`, `alt`,
 * `filename`, `url`, `href`) are in SKIP_KEYS — so an image block in the middle
 * of a post is silently ignored while the paragraphs around it are kept.
 */
function harvest(value: unknown, push: (s: string) => void, underTextKey = false): void {
  if (value == null) return;
  if (typeof value === "string") {
    if (underTextKey || !value.startsWith("http")) push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const el of value) harvest(el, push);
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const key = k.toLowerCase();
      if (SKIP_KEYS.has(key)) continue;
      if (typeof v === "string") {
        if (TEXT_KEYS.has(key)) push(v);
        else if (!v.startsWith("http")) push(v); // stray prose on an unknown key
      } else {
        harvest(v, push, TEXT_KEYS.has(key));
      }
    }
  }
}

/**
 * Extract the indexable text surface of a content item.
 *
 * A single recursive harvest collects prose from EVERY node in the tree, so it
 * works for all Portable Text shapes — paragraphs, headings, lists, blockquotes,
 * code blocks, tables, image captions, and arbitrary custom/future block types —
 * as well as plain-string fields. Two earlier bugs are gone:
 *   - No more `String(array)` → "[object Object],[object Object]" garbage: we
 *     never stringify a container; we descend into it.
 *   - No more `length > 10` filter dropping short prose (short paragraphs, list
 *     items, 1–2 word headings) — that's exactly why "the full post" never
 *     reached the index. Length is not a signal; field ROLE (key) is.
 *
 * Noise (ids, slugs, URLs, image assets/alt/filenames, PT structural keys like
 * `_type`/`_key`/`marks`/`style`) is excluded by KEY via SKIP_KEYS, so an image
 * dropped in the middle of a post doesn't leak its alt text or filename.
 *
 * `contentHash` hashes this same output, so upload text and dedup stay in sync.
 */
export function extractIndexableText(data: unknown): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  const push = (s: string): void => {
    const t = s.trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      parts.push(t);
    }
  };

  harvest(data, push);

  return parts.join("\n\n").trim();
}

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
  /** When true, re-upload every doc even if unchanged (bypass hash dedup). */
  force?: boolean;
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

export function newJob(collections: string[], now: number, force = false): BackfillJob {
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
    force,
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
