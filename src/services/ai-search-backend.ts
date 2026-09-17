/**
 * AiSearchBackend — the managed SearchBackend (the DEFAULT).
 *
 * Cloudflare AI Search owns chunking, embedding, indexing, hybrid search,
 * reranking, and generation. This backend's job is small:
 *   - indexDocument  → render the page to markdown, write it to the R2 bucket
 *                      the instance indexes (AI Search re-crawls on its schedule)
 *   - removeDocument → delete that R2 object
 *   - search / chat  → query the AI Search instance and map to our shapes
 *
 * There is no per-chunk index for us to rebuild — that's the whole point of the
 * managed backend. `indexCollection` just (re)writes every published page's file.
 */

import type { SearchBackend } from "./search-backend";
import type { Ctx } from "./host";
import type { SearchFilters, SearchResponse, ChatResponse, IndexStatusRecord, ChatCitation } from "./types";
import type { AiSearchClient, AiSearchChunk } from "./ai-search-client";
import { type R2Writer, pageKey } from "./r2-writer";

export class AiSearchBackend implements SearchBackend {
  readonly kind = "ai-search" as const;

  constructor(
    private ctx: Ctx,
    private client: AiSearchClient,
    private r2: R2Writer,
    private opts: { resultsLimit: number; chatModel: string },
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
    const r = await this.client.chat(question, { model: this.opts.chatModel, maxNumResults: this.opts.resultsLimit });
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
    return this.client.chatStream(question, { model: this.opts.chatModel, maxNumResults: this.opts.resultsLimit });
  }

  async indexDocument(collectionId: string, contentId: string): Promise<void> {
    const item = await this.ctx.content!.get(collectionId, contentId);
    if (!item || (item.status && item.status !== "published")) {
      await this.removeDocument(collectionId, contentId);
      return;
    }
    const md = renderMarkdown(item.title ?? String(item.data?.title ?? "Untitled"), item.data);
    await this.r2.putText(pageKey(collectionId, contentId), md);
    // AI Search re-indexes the bucket on its own schedule — no explicit sync call.
  }

  async removeDocument(collectionId: string, contentId: string): Promise<void> {
    await this.r2.remove(pageKey(collectionId, contentId));
  }

  async indexCollection(collectionId: string, collectionName = collectionId): Promise<IndexStatusRecord> {
    let count = 0;
    let cursor: string | undefined;
    try {
      do {
        const page = await this.ctx.content!.list({ collection: collectionId, status: "published", limit: 100, cursor });
        for (const item of page.items) {
          const md = renderMarkdown(item.title ?? String(item.data?.title ?? "Untitled"), item.data);
          await this.r2.putText(pageKey(collectionId, item.id), md);
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
        errorMessage: "Files written to R2; AI Search indexes on its own schedule.",
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

/** Render a content item to markdown for R2 (front-matter-ish title + body). */
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
