/**
 * AI Search client — talks to a Cloudflare AI Search instance (the managed
 * service). AI Search does chunking, embedding, indexing,
 * hybrid search, reranking, and generation — we only query it.
 *
 * Two implementations of the same AiSearchClient interface:
 *   - RestAiSearchClient    (sandboxed): POST /ai-search/instances/{name}/search
 *                           and /chat/completions with an API token.
 *   - BindingAiSearchClient (native):    env.<AI_SEARCH>.get(name).search(...) /
 *                           .chatCompletions(...) — tokenless.
 *
 * Shapes per Cloudflare AI Search docs:
 *   search → { search_query, chunks: [{ id, score, text, item: { key, metadata }}] }
 *   chat   → OpenAI format { choices: [{ message: { content }}], chunks: [...] }
 */

import type { HttpAccess } from "./host";
import { sseTextDeltas } from "./sse";

export interface AiSearchChunk {
  id: string;
  score: number;
  text?: string;
  item?: { key?: string; metadata?: Record<string, unknown> };
}

export interface AiSearchResult {
  search_query?: string;
  chunks: AiSearchChunk[];
}

export interface AiSearchChatResult {
  answer: string;
  chunks: AiSearchChunk[];
}

export interface AiSearchClient {
  search(query: string, opts?: { maxNumResults?: number }): Promise<AiSearchResult>;
  chat(question: string, opts?: { model?: string; maxNumResults?: number }): Promise<AiSearchChatResult>;
  /** Streaming chat → incremental answer text deltas (SSE). */
  chatStream(question: string, opts?: { model?: string; maxNumResults?: number }): AsyncIterable<string>;

  // ── Items API (built-in storage) ────────────────────────────────────────────
  /**
   * Upload/replace a document in the instance's built-in storage. Built-in
   * storage is indexed IMMEDIATELY per file (no 6h sync job, no R2, no crawl),
   * which is exactly what we want for publish-time freshness. `key` is the
   * stable filename (e.g. "posts/<id>.md").
   * 
   * Custom metadata can be attached for filtering and linking purposes.
   */
  uploadItem(key: string, content: string, opts?: { metadata?: Record<string, string> }): Promise<void>;
  /** Delete a document by its `key`. No-ops if the key isn't present. */
  deleteItemByKey(key: string): Promise<void>;
}

// ── REST (sandboxed) ──────────────────────────────────────────────────────────

export class RestAiSearchClient implements AiSearchClient {
  constructor(
    private http: HttpAccess,
    private accountId: string,
    private apiToken: string,
    private instance: string,
  ) {}

  private base(): string {
    return `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/ai-search/instances/${this.instance}`;
  }

  async search(query: string, opts?: { maxNumResults?: number }): Promise<AiSearchResult> {
    const res = await this.http.fetch(`${this.base()}/search`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        ai_search_options: opts?.maxNumResults ? { retrieval: { max_num_results: opts.maxNumResults } } : undefined,
      }),
    });
    if (!res.ok) throw new Error(`AI Search search HTTP ${res.status}: ${await safeText(res)}`);
    const json = (await res.json()) as { result?: AiSearchResult } & AiSearchResult;
    // CF wraps some responses in { result }; tolerate both.
    const r = (json.result ?? json) as AiSearchResult;
    return { search_query: r.search_query, chunks: r.chunks ?? [] };
  }

  async chat(question: string, opts?: { model?: string; maxNumResults?: number }): Promise<AiSearchChatResult> {
    const res = await this.http.fetch(`${this.base()}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: question }],
        model: opts?.model,
        stream: false,
        ai_search_options: opts?.maxNumResults ? { retrieval: { max_num_results: opts.maxNumResults } } : undefined,
      }),
    });
    if (!res.ok) throw new Error(`AI Search chat HTTP ${res.status}: ${await safeText(res)}`);
    const json = (await res.json()) as any;
    const body = json.result ?? json;
    return {
      answer: body?.choices?.[0]?.message?.content ?? "",
      chunks: (body?.chunks ?? []) as AiSearchChunk[],
    };
  }

  async *chatStream(question: string, opts?: { model?: string; maxNumResults?: number }): AsyncIterable<string> {
    const res = await this.http.fetch(`${this.base()}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: question }],
        model: opts?.model,
        stream: true,
        ai_search_options: opts?.maxNumResults ? { retrieval: { max_num_results: opts.maxNumResults } } : undefined,
      }),
    });
    if (!res.ok) throw new Error(`AI Search chat stream HTTP ${res.status}: ${await safeText(res)}`);
    yield* sseTextDeltas(res); // ignores the leading `event: chunks`, yields deltas
  }

  async uploadItem(key: string, content: string, opts?: { metadata?: Record<string, string> }): Promise<void> {
    // Items REST API: multipart upload to the instance's built-in storage.
    const form = new FormData();
    form.append("file", new Blob([content], { type: "text/markdown" }), key);
    if (opts?.metadata) {
      // Add metadata as JSON string field
      form.append("metadata", JSON.stringify(opts.metadata));
    }
    const res = await this.http.fetch(`${this.base()}/items`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiToken}` },
      body: form as unknown as BodyInit,
    });
    if (!res.ok) throw new Error(`AI Search item upload HTTP ${res.status}: ${await safeText(res)}`);
  }

  async deleteItemByKey(key: string): Promise<void> {
    const id = await this.findItemId(key);
    if (!id) return;
    const res = await this.http.fetch(`${this.base()}/items/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${this.apiToken}` },
    });
    if (!res.ok && res.status !== 404) throw new Error(`AI Search item delete HTTP ${res.status}: ${await safeText(res)}`);
  }

  private async findItemId(key: string): Promise<string | null> {
    // Page and match by key — do NOT use `search` (it's a content search and
    // won't match a filename key). Mirrors the binding client's approach.
    let page = 1;
    const perPage = 50;
    for (;;) {
      const res = await this.http.fetch(`${this.base()}/items?page=${page}&per_page=${perPage}`, {
        headers: { Authorization: `Bearer ${this.apiToken}` },
      });
      if (!res.ok) return null;
      const json = (await res.json()) as any;
      const items = (json.result ?? json.items ?? []) as Array<{ id?: string; public_id?: string; item_id?: string; key: string }>;
      const m = items.find((it) => it.key === key);
      const id = m?.id ?? m?.public_id ?? m?.item_id ?? null;
      if (id) return id;
      const total = json.result_info?.total_count ?? 0;
      if (items.length === 0 || page * perPage >= total) return null;
      page++;
    }
  }
}

// ── Binding (native) ──────────────────────────────────────────────────────────

/**
 * An item as returned by the Items API list/get.
 *
 * NOTE: the identifier field name varies across the AI Search API surfaces —
 * the dashboard/list can return it as `public_id` (and some responses use
 * `item_id`) rather than `id`. `items.delete()` wants that identifier, so we
 * read whichever is present (see `itemIdOf`). Getting this wrong means deletes
 * silently no-op (delete(undefined)).
 */
export interface AiSearchItem {
  id?: string;
  public_id?: string;
  item_id?: string;
  key: string;
  status?: string;
}

/** Resolve the deletable item id across the field-name variants the API uses. */
function itemIdOf(item: AiSearchItem | undefined): string | null {
  return item?.id ?? item?.public_id ?? item?.item_id ?? null;
}

/** The Items API handle (instance.items.*), per the AI Search Workers binding. */
export interface AiSearchItems {
  upload(name: string, content: string | ArrayBuffer | ReadableStream, options?: { metadata?: Record<string, string> }): Promise<{ id?: string; public_id?: string; key: string }>;
  delete(itemId: string): Promise<void>;
  list(opts?: { page?: number; per_page?: number; search?: string }): Promise<{ result: AiSearchItem[]; result_info?: { total_count?: number; page?: number; per_page?: number } }>;
}

/** Minimal shape of the AI Search instance handle (from the ai_search binding). */
export interface AiSearchInstance {
  search(input: {
    query?: string;
    messages?: Array<{ role: string; content: string }>;
    ai_search_options?: Record<string, unknown>;
  }): Promise<AiSearchResult>;
  chatCompletions(input: {
    messages: Array<{ role: string; content: string }>;
    model?: string;
    stream?: boolean;
    ai_search_options?: Record<string, unknown>;
  }): Promise<any>;
  items: AiSearchItems;
}

export class BindingAiSearchClient implements AiSearchClient {
  constructor(private instance: AiSearchInstance) {}

  async *chatStream(question: string, opts?: { model?: string; maxNumResults?: number }): AsyncIterable<string> {
    const stream = (await this.instance.chatCompletions({
      messages: [{ role: "user", content: question }],
      model: opts?.model,
      stream: true,
      ai_search_options: opts?.maxNumResults ? { retrieval: { max_num_results: opts.maxNumResults } } : undefined,
    })) as ReadableStream;
    yield* sseTextDeltas(new Response(stream));
  }

  async search(query: string, opts?: { maxNumResults?: number }): Promise<AiSearchResult> {
    const r = await this.instance.search({
      query,
      ai_search_options: opts?.maxNumResults ? { retrieval: { max_num_results: opts.maxNumResults } } : undefined,
    });
    return { search_query: r.search_query, chunks: r.chunks ?? [] };
  }

  async chat(question: string, opts?: { model?: string; maxNumResults?: number }): Promise<AiSearchChatResult> {
    const body = await this.instance.chatCompletions({
      messages: [{ role: "user", content: question }],
      model: opts?.model,
      stream: false,
      ai_search_options: opts?.maxNumResults ? { retrieval: { max_num_results: opts.maxNumResults } } : undefined,
    });
    return {
      answer: body?.choices?.[0]?.message?.content ?? "",
      chunks: (body?.chunks ?? []) as AiSearchChunk[],
    };
  }

  async uploadItem(key: string, content: string, opts?: { metadata?: Record<string, string> }): Promise<void> {
    await this.instance.items.upload(key, content, opts ? { metadata: opts.metadata } : undefined);
  }

  async deleteItemByKey(key: string): Promise<void> {
    const id = await this.findItemId(key);
    if (id) await this.instance.items.delete(id);
  }

  /**
   * Resolve an item's id from its `key` by PAGING through the item list and
   * matching on `key`.
   *
   * IMPORTANT: do NOT use the `search` parameter for this. `items.list({search})`
   * does a CONTENT/text search, so a filename key like "posts/<id>.md" does not
   * match and the call returns zero items — which silently broke deletes (the id
   * was never found, so items.delete was never called and unpublished/deleted
   * content stayed in the index). Paging with an exact key match is reliable.
   */
  private async findItemId(key: string): Promise<string | null> {
    let page = 1;
    const perPage = 50;
    for (;;) {
      const res = await this.instance.items.list({ page, per_page: perPage });
      const items = res.result ?? [];
      const id = itemIdOf(items.find((it) => it.key === key));
      if (id) return id;
      const total = res.result_info?.total_count ?? 0;
      if (items.length === 0 || page * perPage >= total) return null;
      page++;
    }
  }
}

/** Namespace binding shape — used to resolve an instance handle by name. */
export interface AiSearchNamespaceBinding {
  get(instanceName: string): AiSearchInstance;
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "<unreadable body>";
  }
}
