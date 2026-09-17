/**
 * RagService — the shared RAG pipeline, transport-agnostic.
 *
 * Depends only on the Embedder / VectorBackend PORTS (services/ports.ts), plus
 * the EmDash ctx for content + storage. The exact same pipeline runs in both
 * sandboxed (REST transports) and native (binding transports) modes — only the
 * transports handed to the constructor differ.
 *
 * Pipeline (from the SonicJS ai-search port):
 *   index:  content → chunk → embed → purge-old → upsert → persist chunk-id map
 *   search: embed query → vector query → app-side filter → best-chunk-per-doc
 *   delete: read chunk-id map → deleteByIds
 *
 * Retained honest limitation: filtering is app-side after a topK query
 * (Vectorize metadata filters were unreliable). ponytail: a filtered query whose
 * true matches sit beyond `vectorTopK` can miss them — raise topK or move to
 * server-side filters.
 */

import { ChunkingService, type ContentChunk } from "./chunking.service";
import type { Ctx, ContentItem, StorageCollection } from "./host";
import type { Embedder, VectorBackend, VectorRecord } from "./ports";
import type {
  RagSettings,
  SearchQuery,
  SearchResponse,
  SearchResult,
  ChunkMapRecord,
} from "./types";

/**
 * Vectorize caps metadata at 10 KiB per vector. We store title + a 500-char
 * display snippet + the full chunk_text, so chunk_text must be bounded or a
 * large chunk fails the whole upsert batch. Cap chunk_text well under 10 KiB to
 * leave room for the other fields and JSON overhead.
 * ponytail: a hard char cap, not a byte cap — multibyte text could still exceed
 * 10 KiB in theory. 6000 chars leaves ~4 KiB of headroom for that plus fields;
 * tighten if you index heavily multibyte content.
 */
const MAX_CHUNK_TEXT_CHARS = 6000;

export class RagService {
  private chunking = new ChunkingService();
  private chunkMap: StorageCollection<ChunkMapRecord>;

  constructor(
    private ctx: Ctx,
    private settings: RagSettings,
    private embedder: Embedder,
    private vectors: VectorBackend,
  ) {
    if (!ctx.content) throw new Error("RAG: content:read capability missing (ctx.content unavailable)");
    this.chunkMap = ctx.storage.chunk_map as StorageCollection<ChunkMapRecord>;
  }

  async indexCollection(collectionId: string): Promise<{
    totalItems: number;
    totalChunks: number;
    indexedChunks: number;
    errors: number;
  }> {
    const items = await this.listPublished(collectionId);
    if (items.length === 0) return { totalItems: 0, totalChunks: 0, indexedChunks: 0, errors: 0 };

    let totalChunks = 0;
    let indexed = 0;
    let errors = 0;

    // Index per-document so each doc gets purge-before-upsert (no orphans on
    // re-sync of a shortened doc) and its chunk-map only reflects what landed.
    for (const item of items) {
      const chunks = this.chunking.chunkContent(
        item.id,
        item.collection,
        item.title ?? String(item.data?.title ?? "Untitled"),
        item.data,
        { status: item.status ?? "published" },
        item.collection,
      );
      totalChunks += chunks.length;
      try {
        const n = await this.upsertDocument(collectionId, item.id, chunks, item.status ?? "published");
        indexed += n;
      } catch (err) {
        this.ctx.log.error("[RAG] index document failed", { doc: item.id, err: String(err) });
        errors += chunks.length;
      }
    }

    return { totalItems: items.length, totalChunks, indexedChunks: indexed, errors };
  }

  async search(query: SearchQuery): Promise<SearchResponse> {
    const start = Date.now();
    const queryEmbedding = await this.embedder.embed(query.query);
    let matches = await this.vectors.query(queryEmbedding, this.settings.vectorTopK);

    const wantCollections =
      query.filters?.collections && query.filters.collections.length > 0
        ? query.filters.collections
        : this.settings.selectedCollections;
    if (wantCollections.length > 0) {
      matches = matches.filter((m) => wantCollections.includes(String(m.metadata?.collection_id)));
    }
    if (query.filters?.status && query.filters.status.length > 0) {
      const allowed = query.filters.status;
      matches = matches.filter((m) => allowed.includes(String(m.metadata?.status)));
    }

    const limit = query.limit ?? this.settings.resultsLimit;

    const bestByDoc = new Map<string, { score: number; title: string; collectionId: string; snippet: string }>();
    for (const m of matches) {
      const contentId = String(m.metadata?.content_id ?? m.id);
      const prev = bestByDoc.get(contentId);
      if (!prev || m.score > prev.score) {
        bestByDoc.set(contentId, {
          score: m.score,
          title: String(m.metadata?.title ?? "Untitled"),
          collectionId: String(m.metadata?.collection_id ?? ""),
          snippet: String(m.metadata?.text ?? ""),
        });
      }
    }

    const results: SearchResult[] = [...bestByDoc.entries()]
      .map(([id, v]) => ({ id, title: v.title, collectionId: v.collectionId, snippet: v.snippet, score: v.score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return { results, total: results.length, queryTimeMs: Date.now() - start };
  }

  /**
   * Retrieve the top matching chunks WITH full text — the grounding context for
   * the chat route. Same embed+query+filter as search(), but returns per-chunk
   * full `chunk_text` (not deduped to best-per-doc, not truncated).
   *
   * ponytail: filtering is applied AFTER the vector query, so a heavily-filtered
   * query can return fewer than `topK` chunks even when more matching content
   * exists beyond the fetched window. We over-fetch (>= vectorTopK) to soften
   * this; raise vectorTopK if chat answers feel under-grounded on filtered sites.
   */
  async retrieveChunks(
    query: string,
    topK: number,
    filters?: SearchQuery["filters"],
  ): Promise<Array<{ contentId: string; title: string; collectionId: string; text: string; score: number }>> {
    const queryEmbedding = await this.embedder.embed(query);
    // Over-fetch: at least vectorTopK, and at least 4x the requested topK, so
    // post-filter still leaves enough context chunks.
    const fetchK = Math.max(this.settings.vectorTopK, topK * 4);
    let matches = await this.vectors.query(queryEmbedding, fetchK);

    const wantCollections =
      filters?.collections && filters.collections.length > 0 ? filters.collections : this.settings.selectedCollections;
    if (wantCollections.length > 0) {
      matches = matches.filter((m) => wantCollections.includes(String(m.metadata?.collection_id)));
    }
    if (filters?.status && filters.status.length > 0) {
      matches = matches.filter((m) => filters.status!.includes(String(m.metadata?.status)));
    }

    return matches
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map((m) => ({
        contentId: String(m.metadata?.content_id ?? m.id),
        title: String(m.metadata?.title ?? "Untitled"),
        collectionId: String(m.metadata?.collection_id ?? ""),
        // Prefer full chunk_text; fall back to the display snippet for vectors
        // indexed before chunk_text existed.
        text: String(m.metadata?.chunk_text ?? m.metadata?.text ?? ""),
        score: m.score,
      }));
  }

  /** Re-index one document; if not published, remove it. */
  async reindexDocument(collectionId: string, contentId: string): Promise<void> {
    const item = await this.ctx.content!.get(collectionId, contentId);
    if (!item || (item.status && item.status !== "published")) {
      await this.removeDocument(contentId);
      return;
    }
    const chunks = this.chunking.chunkContent(
      item.id,
      item.collection,
      item.title ?? String(item.data?.title ?? "Untitled"),
      item.data,
      { status: item.status ?? "published" },
      item.collection,
    );
    await this.upsertDocument(collectionId, contentId, chunks, item.status ?? "published");
  }

  /** Index a document at ANY status (used by the optional draft-indexing path). */
  async indexDocumentAnyStatus(collectionId: string, contentId: string): Promise<void> {
    const item = await this.ctx.content!.get(collectionId, contentId);
    if (!item) {
      await this.removeDocument(contentId);
      return;
    }
    const chunks = this.chunking.chunkContent(
      item.id,
      item.collection,
      item.title ?? String(item.data?.title ?? "Untitled"),
      item.data,
      { status: item.status ?? "draft" },
      item.collection,
    );
    await this.upsertDocument(collectionId, contentId, chunks, item.status ?? "draft");
  }

  /**
   * Purge a document's existing vectors, embed+upsert its new chunks, and record
   * the chunk-id map — but ONLY after the upsert succeeds, so the map never
   * claims vectors that failed to land. Returns the number of chunks indexed.
   *
   * A document that produces no chunks (e.g. empty body) is purged and its
   * chunk-map cleared — never embedded (embedding an empty batch would error).
   */
  private async upsertDocument(
    collectionId: string,
    contentId: string,
    chunks: ContentChunk[],
    status: string,
  ): Promise<number> {
    // Always purge old vectors first so a shortened/edited doc leaves no orphans.
    await this.removeDocument(contentId, /* keepMap */ true);

    if (chunks.length === 0) {
      await this.chunkMap.delete(contentId);
      return 0;
    }

    const embeddings = await this.embedder.embedBatch(chunks.map((c) => `${c.title}\n\n${c.text}`));
    const records: VectorRecord[] = chunks.map((chunk, idx) => ({
      id: chunk.id,
      values: embeddings[idx]!,
      metadata: buildMetadata(chunk, status),
    }));

    await this.vectors.upsert(records);

    await this.chunkMap.put(contentId, {
      contentId,
      collectionId,
      chunkIds: chunks.map((c) => c.id),
      updatedAt: Date.now(),
    });
    return chunks.length;
  }

  /** Real delete: read persisted chunk ids and purge them. */
  async removeDocument(contentId: string, keepMap = false): Promise<void> {
    const rec = await this.chunkMap.get(contentId);
    if (rec?.chunkIds?.length) await this.vectors.deleteByIds(rec.chunkIds);
    if (!keepMap) await this.chunkMap.delete(contentId);
  }

  private async listPublished(collectionId: string): Promise<ContentItem[]> {
    const all: ContentItem[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.ctx.content!.list({
        collection: collectionId,
        status: "published",
        limit: 100,
        cursor,
      });
      all.push(...page.items);
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return all;
  }
}

/** Vector metadata for a chunk, with chunk_text capped under the Vectorize limit. */
function buildMetadata(chunk: ContentChunk, status: string): Record<string, unknown> {
  return {
    content_id: chunk.content_id,
    collection_id: chunk.collection_id,
    title: chunk.title,
    text: chunk.text.substring(0, 500), // display snippet
    chunk_text: chunk.text.substring(0, MAX_CHUNK_TEXT_CHARS), // full-ish text for grounding, capped
    status,
  };
}
