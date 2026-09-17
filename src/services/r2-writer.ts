/**
 * R2 writer — writes/deletes authored page files in the bucket that a Cloudflare
 * AI Search instance indexes. AI Search auto-crawls the bucket, so "indexing" a
 * page just means putting a text/markdown file at a stable key; "removing" means
 * deleting that object.
 *
 * Two implementations:
 *   - RestR2Writer    (sandboxed): R2 S3-compatible? No — use the R2 REST API via
 *                     ctx.http with the account token. (PUT/DELETE object.)
 *   - BindingR2Writer (native):    env.<BUCKET>.put()/delete() directly.
 *
 * ponytail: the sandboxed path uses the Cloudflare R2 REST API
 * (/accounts/{acct}/r2/buckets/{bucket}/objects/{key}); if your account uses the
 * S3-compatible endpoint instead, swap the URL/signing here — the key layout
 * (see pageKey) is unchanged.
 */

import type { HttpAccess, R2Bucket } from "./host";

export interface R2Writer {
  putText(key: string, body: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** Stable object key for a page. Grouped by collection so keys are legible. */
export function pageKey(collectionId: string, contentId: string): string {
  return `${collectionId}/${contentId}.md`;
}

export class RestR2Writer implements R2Writer {
  constructor(
    private http: HttpAccess,
    private accountId: string,
    private apiToken: string,
    private bucket: string,
  ) {}

  private url(key: string): string {
    return `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/r2/buckets/${this.bucket}/objects/${encodeURIComponent(key)}`;
  }

  async putText(key: string, body: string): Promise<void> {
    const res = await this.http.fetch(this.url(key), {
      method: "PUT",
      headers: { Authorization: `Bearer ${this.apiToken}`, "Content-Type": "text/markdown" },
      body,
    });
    if (!res.ok) throw new Error(`R2 put HTTP ${res.status}: ${await safeText(res)}`);
  }

  async remove(key: string): Promise<void> {
    const res = await this.http.fetch(this.url(key), {
      method: "DELETE",
      headers: { Authorization: `Bearer ${this.apiToken}` },
    });
    // 404 on delete is fine (already gone).
    if (!res.ok && res.status !== 404) throw new Error(`R2 delete HTTP ${res.status}: ${await safeText(res)}`);
  }
}

export class BindingR2Writer implements R2Writer {
  constructor(private bucket: R2Bucket) {}

  async putText(key: string, body: string): Promise<void> {
    await this.bucket.put(key, body);
  }

  async remove(key: string): Promise<void> {
    await this.bucket.delete(key);
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "<unreadable body>";
  }
}
