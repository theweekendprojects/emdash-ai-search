/**
 * AI search plugin types — rewritten for the REAL EmDash plugin API.
 *
 * v0.1 mistake: these types referenced Cloudflare Workers bindings
 * (D1Database, a Vectorize handle, a Workers-AI handle) taken off `ctx.env`.
 * EmDash plugins have no such access. The engine now runs over:
 *   - ctx.http    → embeddings + vector REST calls (network:request capability)
 *   - ctx.storage → index metadata + chunk-id map (declared storage collections)
 *   - ctx.content → source content to index (content:read capability)
 *
 * See README "How EmDash native/sandboxed plugins actually work".
 */

/**
 * Which retrieval backend to use.
 *   - "ai-search"  → Cloudflare AI Search (managed): auto-chunks/embeds/indexes an
 *                    R2 bucket, does hybrid search + generation. Minimal setup.
 *                    THE DEFAULT — best for non-technical installers.
 *   - "vectorize"  → self-managed pipeline (our chunking + embeddings + Vectorize).
 *                    Advanced: full control over chunking/models. More setup.
 */
export type KbBackend = "ai-search" | "vectorize";

/** Settings surface (backed by ctx.kv "settings:*", populated by the admin form). */
export interface SearchSettings {
  /** Selected retrieval backend. Defaults to the managed AI Search. */
  kbBackend: KbBackend;

  // ── Shared ──────────────────────────────────────────────────────────────
  cfAccountId: string;
  cfApiToken: string; // token for REST (sandboxed) — used by both backends
  resultsLimit: number;
  selectedCollections: string[];
  chatModel: string;
  maxTokens: number;

  // ── AI Search (managed) ───────────────────────────────────────────────────
  /** AI Search instance name (created in the CF dashboard, points at an R2 bucket). */
  aiSearchInstance: string;
  /** R2 bucket the AI Search instance indexes; authored pages are written here. */
  aiSearchBucket: string;

  // ── Vectorize (self-managed, advanced) ──────────────────────────────────────
  vectorizeIndex: string;
  embeddingModel: string;
  vectorTopK: number;
  chatTopK: number;
}

export const DEFAULT_SETTINGS: SearchSettings = {
  kbBackend: "ai-search", // managed default
  cfAccountId: "",
  cfApiToken: "",
  resultsLimit: 20,
  selectedCollections: [],
  chatModel: "@cf/meta/llama-3.1-8b-instruct",
  maxTokens: 512,
  aiSearchInstance: "emdash-ai-search",
  aiSearchBucket: "emdash-ai-search-content",
  vectorizeIndex: "emdash-ai-search",
  embeddingModel: "@cf/baai/bge-base-en-v1.5",
  vectorTopK: 50,
  chatTopK: 6,
};

export interface IndexStatusRecord {
  collectionId: string;
  collectionName: string;
  totalItems: number;
  indexedChunks: number;
  lastSyncAt: number | null;
  status: "pending" | "indexing" | "completed" | "error";
  errorMessage?: string;
}

/** content_id -> the chunk ids we upserted for it (enables real deletes). */
export interface ChunkMapRecord {
  contentId: string;
  collectionId: string;
  chunkIds: string[];
  updatedAt: number;
}

export interface SearchFilters {
  collections?: string[];
  status?: string[];
}

export interface SearchQuery {
  query: string;
  filters?: SearchFilters;
  limit?: number;
}

export interface SearchResult {
  id: string;
  title: string;
  collectionId: string;
  snippet: string;
  score: number;
}

export interface SearchResponse {
  results: SearchResult[];
  total: number;
  queryTimeMs: number;
}

export interface ChatCitation {
  contentId: string;
  title: string;
  collectionId: string;
  score: number;
}

export interface ChatResponse {
  answer: string;
  citations: ChatCitation[];
  usedChunks: number;
}

/** A vector match as returned by the Vectorize REST query endpoint. */
export interface VectorMatch {
  id: string;
  score: number;
  metadata?: Record<string, unknown>;
}
