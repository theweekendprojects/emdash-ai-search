/**
 * AI Search client — talks to a Cloudflare AI Search instance (the managed
 * service; formerly AutoRAG). AI Search does chunking, embedding, indexing,
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

import type { HttpAccess, R2Bucket } from "./host";
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
}

// ── Binding (native) ──────────────────────────────────────────────────────────

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

/** Re-export for callers that build the native R2 writer alongside. */
export type { R2Bucket };
