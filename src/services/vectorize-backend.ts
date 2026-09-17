/**
 * VectorizeBackend — the self-managed SearchBackend (advanced mode).
 *
 * A thin adapter over the existing engine (SearchService + ChatService +
 * IndexManager). No logic moved: this just implements the SearchBackend interface
 * by delegating to what we already built.
 */

import type { SearchBackend } from "./search-backend";
import type { Ctx } from "./host";
import type { Embedder, VectorBackend, Generator } from "./ports";
import type { SearchSettings, SearchFilters, SearchResponse, ChatResponse, IndexStatusRecord } from "./types";
import { SearchService } from "./search.service";
import { ChatService } from "./chat.service";
import { IndexManager } from "./indexer";

export class VectorizeBackend implements SearchBackend {
  readonly kind = "vectorize" as const;
  private searchEngine: SearchService;
  private chatSvc: ChatService;
  private indexer: IndexManager;

  constructor(
    ctx: Ctx,
    settings: SearchSettings,
    embedder: Embedder,
    vectors: VectorBackend,
    generator: Generator,
  ) {
    this.searchEngine = new SearchService(ctx, settings, embedder, vectors);
    this.chatSvc = new ChatService(this.searchEngine, generator, settings);
    this.indexer = new IndexManager(ctx, settings, embedder, vectors);
  }

  search(query: string, filters?: SearchFilters, limit?: number): Promise<SearchResponse> {
    return this.searchEngine.search({ query, filters, limit });
  }

  chat(question: string, filters?: SearchFilters): Promise<ChatResponse> {
    return this.chatSvc.ask(question, filters);
  }

  chatStream(question: string, filters?: SearchFilters): AsyncIterable<string> {
    return this.chatSvc.askStream(question, filters);
  }

  async indexDocument(collectionId: string, contentId: string): Promise<void> {
    await this.searchEngine.reindexDocument(collectionId, contentId);
  }

  async removeDocument(_collectionId: string, contentId: string): Promise<void> {
    await this.searchEngine.removeDocument(contentId);
  }

  indexCollection(collectionId: string, collectionName?: string): Promise<IndexStatusRecord> {
    return this.indexer.indexCollection(collectionId, collectionName);
  }

  status(): Promise<IndexStatusRecord[]> {
    return this.indexer.allStatus();
  }
}
