/**
 * Embedder — REST implementation (sandboxed mode).
 *
 * Calls the Cloudflare Workers AI REST API over ctx.http.fetch. Used when the
 * plugin runs sandboxed (no host bindings). Requires a CF account id + API
 * token, and `api.cloudflare.com` in the manifest allowedHosts.
 */

import type { HttpAccess } from "./host";
import type { Embedder } from "./ports";

export class RestEmbedder implements Embedder {
  constructor(
    private http: HttpAccess,
    private accountId: string,
    private apiToken: string,
    private model: string,
  ) {}

  async embed(text: string): Promise<number[]> {
    const [vec] = await this.run([preprocess(text)]);
    if (!vec) throw new Error("No embedding returned");
    return vec;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const batchSize = 100;
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize).map(preprocess);
      out.push(...(await this.run(batch)));
    }
    return out;
  }

  private async run(texts: string[]): Promise<number[][]> {
    const url = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/ai/run/${this.model}`;
    const res = await this.http.fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text: texts }),
    });
    if (!res.ok) throw new Error(`Embeddings HTTP ${res.status}: ${await safeText(res)}`);
    const json = (await res.json()) as { result?: { data?: number[][] }; errors?: unknown };
    const data = json?.result?.data;
    if (!Array.isArray(data)) {
      throw new Error(`Embeddings response missing result.data: ${JSON.stringify(json?.errors ?? json)}`);
    }
    return data;
  }
}

export function preprocess(text: string): string {
  if (!text) return "";
  let p = text.trim().replace(/\s+/g, " ");
  if (p.length > 8000) p = p.substring(0, 8000);
  return p;
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "<unreadable body>";
  }
}
