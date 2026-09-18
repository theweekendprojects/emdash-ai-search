/**
 * SearchBackend — the top-level seam that decouples the hook/route layer from HOW
 * retrieval works.
 *
 * One implementation:
 *   - AiSearchBackend (managed) → Cloudflare AI Search does chunking, embedding,
 *     indexing, hybrid search, and generation. We push page files into the
 *     instance's built-in storage (Items API, indexed per file immediately) and
 *     query it. The interface stays an interface so the sandboxed (REST) and
 *     native (binding) clients can be swapped underneath it.
 *
 * `indexCollection` (backfill) is optional because indexing is otherwise driven
 * per-document by the content lifecycle hooks.
 */

import type { SearchResponse, ChatResponse, SearchFilters, IndexStatusRecord } from "./types";

export interface SearchBackend {
  /** Human label for the admin/status view. */
  readonly kind: "ai-search";

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

  /**
   * Index/refresh a single document (called from content:afterPublish / afterSave).
   * Skips the upload when the content is unchanged since it was last indexed
   * (content-hash dedup via doc_state). Pass `{ force: true }` to re-upload
   * regardless — used by the "Force reindex" admin action to repair drift.
   * Returns the action taken so callers can count indexed vs skipped.
   */
  indexDocument(
    collectionId: string,
    contentId: string,
    opts?: { force?: boolean },
  ): Promise<"indexed" | "skipped" | "removed">;

  /** Remove a document from the index (content:afterUnpublish / afterDelete). */
  removeDocument(collectionId: string, contentId: string): Promise<void>;

  /**
   * Backfill an entire collection, uploading every published document to the
   * instance's built-in storage — but skipping unchanged docs (hash dedup)
   * unless `force` is set. Returns a status record for the admin table.
   */
  indexCollection?(
    collectionId: string,
    collectionName?: string,
    opts?: { force?: boolean },
  ): Promise<IndexStatusRecord>;

  /** Status rows for the admin table (may be empty for the managed backend). */
  status(): Promise<IndexStatusRecord[]>;
}
