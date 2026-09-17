/**
 * VectorBackend — REST implementation (sandboxed mode).
 *
 * Talks to the Vectorize v2 REST API over ctx.http.fetch. Used when the plugin
 * runs sandboxed. Requires a CF account id + API token and `api.cloudflare.com`
 * in allowedHosts.
 */

import type { HttpAccess } from "./host";
import type { VectorBackend, VectorRecord } from "./ports";
import type { VectorMatch } from "./types";

export class RestVectorBackend implements VectorBackend {
  constructor(
    private http: HttpAccess,
    private accountId: string,
    private apiToken: string,
    private index: string,
  ) {}

  private base(): string {
    return `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/vectorize/v2/indexes/${this.index}`;
  }

  async upsert(records: VectorRecord[]): Promise<void> {
    if (records.length === 0) return;
    const ndjson = records.map((r) => JSON.stringify(r)).join("\n");
    const res = await this.http.fetch(`${this.base()}/upsert`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiToken}`, "Content-Type": "application/x-ndjson" },
      body: ndjson,
    });
    if (!res.ok) throw new Error(`Vectorize upsert HTTP ${res.status}: ${await safeText(res)}`);
  }

  async query(vector: number[], topK: number): Promise<VectorMatch[]> {
    const res = await this.http.fetch(`${this.base()}/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ vector, topK, returnMetadata: "all" }),
    });
    if (!res.ok) throw new Error(`Vectorize query HTTP ${res.status}: ${await safeText(res)}`);
    const json = (await res.json()) as { result?: { matches?: VectorMatch[] } };
    return json?.result?.matches ?? [];
  }

  async deleteByIds(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const res = await this.http.fetch(`${this.base()}/delete_by_ids`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    if (!res.ok) throw new Error(`Vectorize delete HTTP ${res.status}: ${await safeText(res)}`);
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "<unreadable body>";
  }
}
