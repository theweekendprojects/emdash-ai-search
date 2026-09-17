/**
 * VectorizeBackend — the self-managed RagBackend (advanced mode).
 *
 * A thin adapter over the existing engine (RagService + ChatService +
 * IndexManager). No logic moved: this just implements the RagBackend interface
 * by delegating to what we already built.
 */

import type { RagBackend } from "./rag-backend";
import type { Ctx } from "./host";
import type { Embedder, VectorBackend, Generator } from "./ports";
import type { RagSettings, SearchFilters, SearchResponse, ChatResponse, IndexStatusRecord } from "./types";
import { RagService } from "./custom-rag.service";
import { ChatService } from "./chat.service";
import { IndexManager } from "./indexer";

export class VectorizeBackend implements RagBackend {
  readonly kind = "vectorize" as const;
  private rag: RagService;
  private chatSvc: ChatService;
  private indexer: IndexManager;

  constructor(
    ctx: Ctx,
    settings: RagSettings,
    embedder: Embedder,
    vectors: VectorBackend,
    generator: Generator,
  ) {
    this.rag = new RagService(ctx, settings, embedder, vectors);
    this.chatSvc = new ChatService(this.rag, generator, settings);
    this.indexer = new IndexManager(ctx, settings, embedder, vectors);
  }

  search(query: string, filters?: SearchFilters, limit?: number): Promise<SearchResponse> {
    return this.rag.search({ query, filters, limit });
  }

  chat(question: string, filters?: SearchFilters): Promise<ChatResponse> {
    return this.chatSvc.ask(question, filters);
  }

  chatStream(question: string, filters?: SearchFilters): AsyncIterable<string> {
    return this.chatSvc.askStream(question, filters);
  }

  async indexDocument(collectionId: string, contentId: string): Promise<void> {
    await this.rag.reindexDocument(collectionId, contentId);
  }

  async removeDocument(_collectionId: string, contentId: string): Promise<void> {
    await this.rag.removeDocument(contentId);
  }

  indexCollection(collectionId: string, collectionName?: string): Promise<IndexStatusRecord> {
    return this.indexer.indexCollection(collectionId, collectionName);
  }

  status(): Promise<IndexStatusRecord[]> {
    return this.indexer.allStatus();
  }
}
