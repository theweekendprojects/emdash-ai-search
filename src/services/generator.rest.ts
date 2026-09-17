/**
 * Generator — REST implementation (sandboxed mode).
 *
 * Calls the Cloudflare Workers AI REST API over ctx.http.fetch with a
 * text-generation model (e.g. @cf/meta/llama-3.1-8b-instruct). Same endpoint
 * family as embeddings; the body carries `messages` instead of `text`.
 * Response shape: { result: { response: string } }.
 */

import type { HttpAccess } from "./host";
import type { Generator, ChatMessage } from "./ports";
import { sseTextDeltas } from "./sse";

export class RestGenerator implements Generator {
  constructor(
    private http: HttpAccess,
    private accountId: string,
    private apiToken: string,
    private model: string,
  ) {}

  private url(): string {
    return `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/ai/run/${this.model}`;
  }

  async generate(messages: ChatMessage[], opts?: { maxTokens?: number }): Promise<string> {
    const res = await this.http.fetch(this.url(), {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messages, max_tokens: opts?.maxTokens ?? 512, stream: false }),
    });
    if (!res.ok) throw new Error(`Generation HTTP ${res.status}: ${await safeText(res)}`);
    const json = (await res.json()) as { result?: { response?: string }; errors?: unknown };
    const text = json?.result?.response;
    if (typeof text !== "string") {
      throw new Error(`Generation response missing result.response: ${JSON.stringify(json?.errors ?? json)}`);
    }
    return text;
  }

  // NOTE: usable from a context that can stream. The sandboxed *route* can't
  // return a stream (host wraps route results in JSON), so in practice this is
  // exercised by native streaming; kept correct for completeness/parity.
  async *generateStream(messages: ChatMessage[], opts?: { maxTokens?: number }): AsyncIterable<string> {
    const res = await this.http.fetch(this.url(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({ messages, max_tokens: opts?.maxTokens ?? 512, stream: true }),
    });
    if (!res.ok) throw new Error(`Generation stream HTTP ${res.status}: ${await safeText(res)}`);
    yield* sseTextDeltas(res);
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "<unreadable body>";
  }
}
