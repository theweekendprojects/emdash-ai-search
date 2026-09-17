/**
 * Transport ports (interfaces) for the two things a plugin can't do purely
 * in-isolate: generate embeddings and talk to a vector index.
 *
 * There are two implementations of each:
 *   - REST      (sandboxed mode) — calls Cloudflare REST APIs over ctx.http
 *   - Bindings  (native mode)    — calls env.AI / env.VECTORIZE directly
 *
 * RagService / IndexManager depend ONLY on these ports, so the exact same RAG
 * pipeline runs in both modes. Only the wiring differs per entry point.
 */

import type { VectorMatch } from "./types";

export interface Embedder {
  /** One text → one embedding vector. */
  embed(text: string): Promise<number[]>;
  /** Many texts → many vectors (batched by the implementation). */
  embedBatch(texts: string[]): Promise<number[][]>;
}

export interface VectorRecord {
  id: string;
  values: number[];
  metadata?: Record<string, unknown>;
}

export interface VectorBackend {
  upsert(records: VectorRecord[]): Promise<void>;
  query(vector: number[], topK: number): Promise<VectorMatch[]>;
  deleteByIds(ids: string[]): Promise<void>;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface Generator {
  /** Non-streaming chat completion → the assistant's text. */
  generate(messages: ChatMessage[], opts?: { maxTokens?: number }): Promise<string>;
  /** Streaming completion → incremental text deltas (SSE). */
  generateStream(messages: ChatMessage[], opts?: { maxTokens?: number }): AsyncIterable<string>;
}
