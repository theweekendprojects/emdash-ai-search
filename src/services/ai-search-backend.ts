/**
 * AiSearchBackend — the managed SearchBackend (the DEFAULT).
 *
 * Cloudflare AI Search owns chunking, embedding, indexing, hybrid search,
 * reranking, and generation. This backend's job is small:
 *   - indexDocument  → render the page to markdown and upload it to the
 *                      instance's built-in storage (Items API), which indexes
 *                      it per file, immediately — no R2, no crawl, no sync job.
 *   - removeDocument → delete that item by key
 *   - search / chat  → query the AI Search instance and map to our shapes
 *
 * There is no per-chunk index for us to rebuild — that's the whole point of the
 * managed backend. `indexCollection` just (re)uploads every published page.
 */

import type { SearchBackend } from "./search-backend";
import type { Ctx } from "./host";
import type { SearchFilters, SearchResponse, ChatResponse, IndexStatusRecord, ChatCitation } from "./types";
import type { AiSearchClient, AiSearchChunk } from "./ai-search-client";

/** Stable item key for a content entry in AI Search built-in storage. */
export function pageKey(collectionId: string, contentId: string): string {
  return `${collectionId}/${contentId}.md`;
}

/**
 * AI Search built-in storage caps a single item at 4 MB. Cap our markdown a
 * little under that (leaving headroom for UTF-8 multibyte expansion) so an
 * unusually large post can't make every publish throw. Truncation is on a byte
 * budget, then trimmed back to a char boundary.
 */
export const MAX_ITEM_BYTES = 4 * 1024 * 1024; // 4 MB
const SAFE_ITEM_BYTES = MAX_ITEM_BYTES - 4096; // headroom for the multibyte tail

export function capMarkdown(md: string): { content: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(md);
  if (bytes.length <= SAFE_ITEM_BYTES) return { content: md, truncated: false };
  // Slice on the byte budget, then decode ignoring a possibly-split trailing char.
  const slice = bytes.subarray(0, SAFE_ITEM_BYTES);
  const content = new TextDecoder("utf-8", { fatal: false }).decode(slice).replace(/\uFFFD+$/, "");
  return { content, truncated: true };
}

export class AiSearchBackend implements SearchBackend {
  readonly kind = "ai-search" as const;

  constructor(
    private ctx: Ctx,
    private client: AiSearchClient,
    private opts: { resultsLimit: number },
  ) {
    if (!ctx.content) throw new Error("AI Search: content:read capability missing (ctx.content)");
  }

  async search(query: string, _filters?: SearchFilters, limit?: number): Promise<SearchResponse> {
    const start = Date.now();
    const r = await this.client.search(query, { maxNumResults: limit ?? this.opts.resultsLimit });
    // Dedupe chunks to one result per source document (item.key).
    const byKey = new Map<string, { title: string; snippet: string; score: number }>();
    for (const c of r.chunks) {
      const key = c.item?.key ?? c.id;
      const prev = byKey.get(key);
      if (!prev || c.score > prev.score) {
        byKey.set(key, { title: titleFromChunk(c), snippet: (c.text ?? "").slice(0, 500), score: c.score });
      }
    }
    const results = [...byKey.entries()]
      .map(([key, v]) => ({ id: key, title: v.title, collectionId: collectionFromKey(key), snippet: v.snippet, score: v.score }))
      .sort((a, b) => b.score - a.score);
    return { results, total: results.length, queryTimeMs: Date.now() - start };
  }

  async chat(question: string, _filters?: SearchFilters): Promise<ChatResponse> {
    // NOTE: do NOT pass a `model` override to the managed AI Search instance —
    // it uses the generation model configured on the instance itself. Passing a
    // Workers-AI model id here makes chat/completions fail with
    // "AiSearchError: Internal Error" (the dashboard Playground sends none).
    const r = await this.client.chat(question, { maxNumResults: this.opts.resultsLimit });
    const byKey = new Map<string, ChatCitation>();
    for (const c of r.chunks) {
      const key = c.item?.key ?? c.id;
      const prev = byKey.get(key);
      if (!prev || c.score > prev.score) {
        byKey.set(key, { contentId: idFromKey(key), title: titleFromChunk(c), collectionId: collectionFromKey(key), score: c.score });
      }
    }
    return {
      answer: (r.answer ?? "").trim(),
      citations: [...byKey.values()].sort((a, b) => b.score - a.score),
      usedChunks: r.chunks.length,
    };
  }

  chatStream(question: string, _filters?: SearchFilters): AsyncIterable<string> {
    // Same as chat(): no model override for the managed instance.
    return this.client.chatStream(question, { maxNumResults: this.opts.resultsLimit });
  }

  async indexDocument(collectionId: string, contentId: string): Promise<void> {
    const item = await this.ctx.content!.get(collectionId, contentId);
    if (!item || (item.status && item.status !== "published")) {
      await this.removeDocument(collectionId, contentId);
      return;
    }
    const raw = renderMarkdown(titleOf(item), item.data);
    const { content, truncated } = capMarkdown(raw);
    if (truncated) {
      this.ctx.log.warn("[ai-search] document exceeds 4MB item limit — truncated for indexing", {
        collectionId,
        contentId,
      });
    }
    // Built-in storage: an uploaded file is queued and indexed per file (no R2,
    // no 6h crawl/sync), so a publish becomes searchable on its own within
    // moments — not on a shared multi-hour schedule.
    await this.client.uploadItem(pageKey(collectionId, contentId), content);
  }

  async removeDocument(collectionId: string, contentId: string): Promise<void> {
    await this.client.deleteItemByKey(pageKey(collectionId, contentId));
  }

  async indexCollection(collectionId: string, collectionName = collectionId): Promise<IndexStatusRecord> {
    let count = 0;
    let cursor: string | undefined;
    try {
      do {
        // EmDash content API: list(collection, options); status filter goes in
        // `where`, NOT a top-level `status`. Title lives in item.data (ContentItem
        // has no top-level title). Getting this wrong silently returns 0 items.
        const page = await this.ctx.content!.list(collectionId, { where: { status: "published" }, limit: 100, cursor });
        for (const item of page.items) {
          const { content } = capMarkdown(renderMarkdown(titleOf(item), item.data));
          await this.client.uploadItem(pageKey(collectionId, item.id), content);
          count++;
        }
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor);
      return {
        collectionId,
        collectionName,
        totalItems: count,
        indexedChunks: count, // managed: 1 file per doc; chunks are AI Search's business
        lastSyncAt: Date.now(),
        status: "completed",
        errorMessage: "Uploaded to AI Search built-in storage; indexed per file on upload.",
      };
    } catch (err) {
      return {
        collectionId,
        collectionName,
        totalItems: count,
        indexedChunks: count,
        lastSyncAt: Date.now(),
        status: "error",
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async status(): Promise<IndexStatusRecord[]> {
    // The managed backend keeps no local per-collection index state. Indexing
    // status lives in the Cloudflare dashboard. Return empty; the admin shows a
    // note directing the operator there.
    return [];
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

/** EmDash ContentItem has no top-level title; it lives in data.{title,name}. */
function titleOf(item: { data?: Record<string, unknown> }): string {
  const t = item.data?.title ?? item.data?.name;
  return typeof t === "string" && t.trim() ? t : "Untitled";
}

/** Render a content item to markdown for upload (front-matter-ish title + body). */
function renderMarkdown(title: string, data: Record<string, unknown>): string {
  const parts: string[] = [`# ${title}`, ""];
  for (const key of ["description", "summary", "content", "body", "text"]) {
    const v = data?.[key];
    if (typeof v === "string" && v.trim()) parts.push(v.trim(), "");
  }
  // Fallback: if none of the known fields had text, dump remaining string fields.
  if (parts.length <= 2) {
    for (const [k, v] of Object.entries(data ?? {})) {
      if (typeof v === "string" && v.length > 10 && !v.startsWith("http") && !["id", "slug", "url"].includes(k)) {
        parts.push(v, "");
      }
    }
  }
  return parts.join("\n");
}

function collectionFromKey(key: string): string {
  const i = key.indexOf("/");
  return i > 0 ? key.slice(0, i) : "";
}

function idFromKey(key: string): string {
  const base = key.slice(key.indexOf("/") + 1);
  return base.replace(/\.md$/, "");
}

function titleFromChunk(c: AiSearchChunk): string {
  const t = c.item?.metadata?.title;
  if (typeof t === "string" && t) return t;
  // Fall back to first markdown H1 in the chunk text.
  const m = (c.text ?? "").match(/^#\s+(.+)$/m);
  return m?.[1] ?? "Untitled";
}
