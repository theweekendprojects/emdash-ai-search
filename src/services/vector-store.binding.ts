/**
 * VectorBackend — binding implementation (native / trusted mode).
 *
 * Calls the Vectorize binding directly (env.VECTORIZE.upsert/query/deleteByIds),
 * per the Vectorize client API. No API token. Only available to a trusted
 * (native) plugin in the host Worker isolate.
 *
 * Note: Vectorize writes are asynchronous — upserted vectors take a few seconds
 * to become queryable. This is the same for both binding and REST paths.
 */

import type { VectorBackend, VectorRecord } from "./ports";
import type { VectorMatch } from "./types";

/** Minimal shape of the Vectorize binding (see Vectorize client API). */
export interface VectorizeBinding {
  upsert(vectors: VectorRecord[]): Promise<unknown>;
  query(
    vector: number[],
    opts: { topK?: number; returnMetadata?: "none" | "indexed" | "all"; returnValues?: boolean },
  ): Promise<{ matches?: VectorMatch[] }>;
  deleteByIds(ids: string[]): Promise<unknown>;
}

export class BindingVectorBackend implements VectorBackend {
  constructor(private index: VectorizeBinding) {}

  async upsert(records: VectorRecord[]): Promise<void> {
    if (records.length === 0) return;
    await this.index.upsert(records);
  }

  async query(vector: number[], topK: number): Promise<VectorMatch[]> {
    // returnMetadata:'all' caps topK at 50 per the Vectorize API.
    const res = await this.index.query(vector, { topK: Math.min(topK, 50), returnMetadata: "all" });
    return res?.matches ?? [];
  }

  async deleteByIds(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.index.deleteByIds(ids);
  }
}
