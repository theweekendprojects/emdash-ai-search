/**
 * IndexManager — status tracking via ctx.storage.index_meta, transport-agnostic.
 *
 * Takes the Embedder + VectorBackend ports (same as SearchService) so it works
 * unchanged in both sandboxed and native modes.
 */

import { SearchService } from "./search.service";
import type { Ctx, StorageCollection } from "./host";
import type { Embedder, VectorBackend } from "./ports";
import type { SearchSettings, IndexStatusRecord } from "./types";

export class IndexManager {
  private meta: StorageCollection<IndexStatusRecord>;

  constructor(
    private ctx: Ctx,
    private settings: SearchSettings,
    private embedder: Embedder,
    private vectors: VectorBackend,
  ) {
    this.meta = ctx.storage.index_meta as StorageCollection<IndexStatusRecord>;
  }

  async indexCollection(collectionId: string, collectionName = collectionId): Promise<IndexStatusRecord> {
    await this.meta.put(collectionId, {
      collectionId,
      collectionName,
      totalItems: 0,
      indexedChunks: 0,
      lastSyncAt: null,
      status: "indexing",
    });

    try {
      const search = new SearchService(this.ctx, this.settings, this.embedder, this.vectors);
      const r = await search.indexCollection(collectionId);
      const rec: IndexStatusRecord = {
        collectionId,
        collectionName,
        totalItems: r.totalItems,
        indexedChunks: r.indexedChunks,
        lastSyncAt: Date.now(),
        status: r.errors > 0 ? "error" : "completed",
        errorMessage: r.errors > 0 ? `${r.errors} chunk(s) failed to index` : undefined,
      };
      await this.meta.put(collectionId, rec);
      return rec;
    } catch (err) {
      const rec: IndexStatusRecord = {
        collectionId,
        collectionName,
        totalItems: 0,
        indexedChunks: 0,
        lastSyncAt: Date.now(),
        status: "error",
        errorMessage: err instanceof Error ? err.message : String(err),
      };
      await this.meta.put(collectionId, rec);
      return rec;
    }
  }

  async syncAll(collectionIds: string[]): Promise<void> {
    for (const id of collectionIds) {
      try {
        await this.indexCollection(id);
      } catch (err) {
        this.ctx.log.error("[ai-search] sync failed", { collection: id, err: String(err) });
      }
    }
  }

  async allStatus(): Promise<IndexStatusRecord[]> {
    const page = await this.meta.query({ limit: 100 });
    return page.items.map((i) => i.data);
  }
}
