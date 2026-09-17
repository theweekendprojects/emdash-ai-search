/**
 * SearchBackend — the top-level seam that decouples the hook/route layer from HOW
 * retrieval works. Selected by the `kbBackend` setting.
 *
 * Two implementations:
 *   - AiSearchBackend  (managed)  → Cloudflare AI Search does chunking, embedding,
 *                                   indexing, hybrid search, and generation. We
 *                                   only feed it page files (into R2) and query it.
 *   - VectorizeBackend (self-mgd) → our own chunk→embed→Vectorize pipeline +
 *                                   Workers-AI generation (the original engine).
 *
 * The two backends do genuinely different amounts of work, so the interface is
 * the *union of capabilities* the hooks/routes need; each backend implements it
 * in its own way. `indexAll` (backfill) is optional because AI Search indexes R2
 * on its own schedule.
 */

import type { SearchResponse, ChatResponse, SearchFilters, IndexStatusRecord } from "./types";

export interface SearchBackend {
  /** Human label for the admin/status view. */
  readonly kind: "ai-search" | "vectorize";

  /** Semantic search → ranked results. */
  search(query: string, filters?: SearchFilters, limit?: number): Promise<SearchResponse>;

  /** Retrieve-then-generate a grounded answer with citations. */
  chat(question: string, filters?: SearchFilters): Promise<ChatResponse>;

  /**
   * Streaming variant of chat → incremental answer text deltas. Optional: only
   * usable where the runtime can return a stream (native mode). Backends that
   * can stream implement it; callers fall back to `chat()` otherwise.
   */
  chatStream?(question: string, filters?: SearchFilters): AsyncIterable<string>;

  /** Index/refresh a single document (called from content:afterPublish / afterSave). */
  indexDocument(collectionId: string, contentId: string): Promise<void>;

  /** Remove a document from the index (content:afterUnpublish / afterDelete). */
  removeDocument(collectionId: string, contentId: string): Promise<void>;

  /**
   * Backfill an entire collection. Optional: the managed backend has no
   * per-chunk index to rebuild (it re-crawls R2), so it may no-op or just
   * (re)write all files. Returns a status record for the admin table.
   */
  indexCollection?(collectionId: string, collectionName?: string): Promise<IndexStatusRecord>;

  /** Status rows for the admin table (may be empty for the managed backend). */
  status(): Promise<IndexStatusRecord[]>;
}
