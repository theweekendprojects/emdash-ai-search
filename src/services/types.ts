/**
 * AI search plugin types.
 *
 * The plugin is all-in on Cloudflare AI Search (managed):
 *   - ctx.content → source content to index (content:read capability)
 *   - the AI Search binding (native) or REST (sandboxed) → push content into the
 *     instance's built-in storage (Items API), indexed immediately per file.
 *   - Cloudflare's public-endpoint UI snippets → the site-facing search/chat UI,
 *     injected via page:fragments (no custom widget, no /chat route).
 */

/** Settings surface (backed by ctx.kv "settings:*", populated by the admin form). */
export interface SearchSettings {
  // ── Cloudflare account (sandboxed REST mode only) ───────────────────────────
  cfAccountId: string;
  cfApiToken: string;

  // ── Indexing ────────────────────────────────────────────────────────────────
  /** Max results the backend requests when it queries the instance. */
  resultsLimit: number;
  /** Collections to index (JSON array in kv). Backfill/sync operate on these. */
  selectedCollections: string[];
  /** AI Search instance name (created in the Cloudflare dashboard). */
  aiSearchInstance: string;

  // ── Public endpoint + UI snippets (the site-facing search/chat UI) ──────────
  /**
   * The instance's public endpoint URL, e.g.
   * `https://<id>.search.ai.cloudflare.com/` (or a custom domain). Enable it once
   * in the Cloudflare dashboard and paste it here; the snippets read it.
   */
  publicEndpointUrl: string;
  /** Inject Cloudflare's floating chat bubble on every public page (default true). */
  showChatBubble: boolean;
  /** Inject Cloudflare's Cmd/Ctrl+K search modal on every public page (default false). */
  showSearchModal: boolean;
  /** Snippet theme. */
  snippetTheme: "auto" | "light" | "dark";
  /** Optional accent color (hex) applied to the snippets via CSS var. */
  snippetAccent: string;

  // ── Ops ─────────────────────────────────────────────────────────────────────
  /**
   * Show a "Run backfill batch now" button in the admin, letting an operator
   * drain one batch by hand. Useful when the host's cron dispatch isn't
   * advancing the backfill on its own (the scheduled drain relies on the `cron`
   * hook firing into the plugin). Default off.
   */
  showManualDrain: boolean;
}

export const DEFAULT_SETTINGS: SearchSettings = {
  cfAccountId: "",
  cfApiToken: "",
  resultsLimit: 20,
  selectedCollections: [],
  aiSearchInstance: "emdash-ai-search",
  publicEndpointUrl: "",
  showChatBubble: true,
  showSearchModal: false,
  snippetTheme: "auto",
  snippetAccent: "",
  showManualDrain: false,
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
  /** Public URL to the original post on your site. */
  publicUrl?: string;
}

export interface ChatResponse {
  answer: string;
  citations: ChatCitation[];
  usedChunks: number;
}


