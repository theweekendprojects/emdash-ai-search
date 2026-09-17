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
   */
  uploadItem(key: string, content: string): Promise<void>;
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

  async uploadItem(key: string, content: string): Promise<void> {
    // Items REST API: multipart upload to the instance's built-in storage.
    const form = new FormData();
    form.append("file", new Blob([content], { type: "text/markdown" }), key);
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
    const res = await this.http.fetch(`${this.base()}/items?search=${encodeURIComponent(key)}&per_page=50`, {
      headers: { Authorization: `Bearer ${this.apiToken}` },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as any;
    const items = (json.result ?? json.items ?? []) as Array<{ id: string; key: string }>;
    return items.find((it) => it.key === key)?.id ?? null;
  }
}

// ── Binding (native) ──────────────────────────────────────────────────────────

/** An item as returned by the Items API list/get. */
export interface AiSearchItem {
  id: string;
  key: string;
  status?: string;
}

/** The Items API handle (instance.items.*), per the AI Search Workers binding. */
export interface AiSearchItems {
  upload(name: string, content: string | ArrayBuffer | ReadableStream, options?: { metadata?: Record<string, string> }): Promise<{ id: string; key: string }>;
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

  async uploadItem(key: string, content: string): Promise<void> {
    await this.instance.items.upload(key, content);
  }

  async deleteItemByKey(key: string): Promise<void> {
    // The Items API deletes by item id, not key, so resolve the id first.
    // `search` filters items by text; we match the exact key from the page.
    const id = await this.findItemId(key);
    if (id) await this.instance.items.delete(id);
  }

  private async findItemId(key: string): Promise<string | null> {
    // Prefer a targeted search, then fall back to paging.
    try {
      const hit = await this.instance.items.list({ search: key, per_page: 50 });
      const match = (hit.result ?? []).find((it) => it.key === key);
      if (match) return match.id;
    } catch {
      /* fall through to paging */
    }
    let page = 1;
    for (;;) {
      const res = await this.instance.items.list({ page, per_page: 50 });
      const items = res.result ?? [];
      const match = items.find((it) => it.key === key);
      if (match) return match.id;
      const total = res.result_info?.total_count ?? 0;
      if (items.length === 0 || page * 50 >= total) return null;
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
