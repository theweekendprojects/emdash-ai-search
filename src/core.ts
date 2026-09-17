/**
 * Shared plugin core — hook + route logic that is IDENTICAL in both modes and
 * across both backends.
 *
 * The seam: everything here talks to a `RagBackend` (search/chat/index/remove).
 * A `BackendFactory` (supplied per entry point — sandboxed vs native) builds the
 * right RagBackend based on the `kbBackend` setting:
 *   - "ai-search" (default) → AiSearchBackend (managed)
 *   - "vectorize"           → VectorizeBackend (self-managed pipeline)
 *
 * Sandboxed entry → REST transports; native entry → binding transports. Neither
 * this file nor the hooks/routes know which backend or transport is in play.
 */

import type { Ctx } from "./services/host";
import type { RagBackend } from "./services/rag-backend";
import { DEFAULT_SETTINGS, type RagSettings } from "./services/types";
import { BackfillService } from "./services/backfill.service";

/** Cron schedule name for the backfill drainer. */
export const BACKFILL_CRON = "rag-backfill";

/** Builds the selected RagBackend for a given ctx + settings. Per entry point. */
export interface BackendFactory {
  build(ctx: Ctx, settings: RagSettings): RagBackend;
}

export async function loadSettings(ctx: Ctx): Promise<RagSettings> {
  const get = async <T>(k: string, d: T): Promise<T> => ((await ctx.kv.get<T>(`settings:${k}`)) ?? d);
  let selectedCollections: string[] = [];
  try {
    const raw = await get<string>("selectedCollections", "[]");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) selectedCollections = parsed.map(String);
  } catch {
    selectedCollections = [];
  }
  const backend = (await get<string>("kbBackend", DEFAULT_SETTINGS.kbBackend)) as RagSettings["kbBackend"];
  return {
    kbBackend: backend === "vectorize" ? "vectorize" : "ai-search",
    cfAccountId: await get("cfAccountId", DEFAULT_SETTINGS.cfAccountId),
    cfApiToken: await get("cfApiToken", DEFAULT_SETTINGS.cfApiToken),
    resultsLimit: Number(await get("resultsLimit", DEFAULT_SETTINGS.resultsLimit)),
    selectedCollections,
    chatModel: await get("chatModel", DEFAULT_SETTINGS.chatModel),
    maxTokens: Number(await get("maxTokens", DEFAULT_SETTINGS.maxTokens)),
    aiSearchInstance: await get("aiSearchInstance", DEFAULT_SETTINGS.aiSearchInstance),
    aiSearchBucket: await get("aiSearchBucket", DEFAULT_SETTINGS.aiSearchBucket),
    vectorizeIndex: await get("vectorizeIndex", DEFAULT_SETTINGS.vectorizeIndex),
    embeddingModel: await get("embeddingModel", DEFAULT_SETTINGS.embeddingModel),
    vectorTopK: Number(await get("vectorTopK", DEFAULT_SETTINGS.vectorTopK)),
    chatTopK: Number(await get("chatTopK", DEFAULT_SETTINGS.chatTopK)),
  };
}

export async function indexDraftsEnabled(ctx: Ctx): Promise<boolean> {
  return (await ctx.kv.get<boolean>("settings:indexDrafts")) === true;
}

async function backendFor(ctx: Ctx, factory: BackendFactory): Promise<RagBackend> {
  return factory.build(ctx, await loadSettings(ctx));
}

// ── Hook bodies (shared) ────────────────────────────────────────────────────

export async function onInstall(ctx: Ctx): Promise<void> {
  const defaults: Record<string, unknown> = {
    "settings:kbBackend": DEFAULT_SETTINGS.kbBackend,
    "settings:resultsLimit": DEFAULT_SETTINGS.resultsLimit,
    "settings:selectedCollections": "[]",
    "settings:indexDrafts": false,
    "settings:chatModel": DEFAULT_SETTINGS.chatModel,
    "settings:maxTokens": DEFAULT_SETTINGS.maxTokens,
    "settings:aiSearchInstance": DEFAULT_SETTINGS.aiSearchInstance,
    "settings:aiSearchBucket": DEFAULT_SETTINGS.aiSearchBucket,
    "settings:vectorizeIndex": DEFAULT_SETTINGS.vectorizeIndex,
    "settings:embeddingModel": DEFAULT_SETTINGS.embeddingModel,
    "settings:vectorTopK": DEFAULT_SETTINGS.vectorTopK,
    "settings:chatTopK": DEFAULT_SETTINGS.chatTopK,
  };
  for (const [k, v] of Object.entries(defaults)) {
    if ((await ctx.kv.get(k)) === null) await ctx.kv.set(k, v);
  }
}

/** Register the backfill drainer schedule. Called from plugin:activate. */
export async function onActivate(ctx: Ctx): Promise<void> {
  try {
    // Drain every minute; each tick processes one bounded batch until done.
    await ctx.cron?.schedule(BACKFILL_CRON, { schedule: "* * * * *" });
  } catch (err) {
    ctx.log.warn("[backfill] cron schedule registration failed", { err: String(err) });
  }
}

export async function onAfterPublish(ctx: Ctx, factory: BackendFactory, collection: string, contentId: string): Promise<void> {
  const backend = await backendFor(ctx, factory);
  await backend.indexDocument(collection, contentId);
}

export async function onAfterSave(ctx: Ctx, factory: BackendFactory, collection: string, contentId: string): Promise<void> {
  if (!(await indexDraftsEnabled(ctx))) return;
  const backend = await backendFor(ctx, factory);
  await backend.indexDocument(collection, contentId);
}

export async function onRemove(ctx: Ctx, factory: BackendFactory, collection: string, contentId: string): Promise<void> {
  const backend = await backendFor(ctx, factory);
  await backend.removeDocument(collection, contentId);
}

// ── Route bodies (shared) ─────────────────────────────────────────────────────

export async function routeSearch(ctx: Ctx, factory: BackendFactory, body: Record<string, unknown>) {
  const query = String(body.query ?? "").trim();
  if (!query) return { error: "query required" };
  const backend = await backendFor(ctx, factory);
  return backend.search(query, body.filters as any, body.limit as number | undefined);
}

export async function routeChat(ctx: Ctx, factory: BackendFactory, body: Record<string, unknown>) {
  const question = String(body.question ?? body.query ?? "").trim();
  if (!question) return { error: "question required" };
  const backend = await backendFor(ctx, factory);
  return backend.chat(question, body.filters as any);
}

/**
 * NATIVE-ONLY streaming chat. Returns a real SSE `Response` (`data: {delta}` +
 * `[DONE]`). Do NOT wire this into a sandboxed route — the sandbox bridge wraps
 * route results in a JSON envelope and refuses raw Responses (per EmDash docs),
 * so streaming only works from the host isolate (native mode). Falls back to a
 * single JSON `data:` event if the backend can't stream.
 */
export async function routeChatStream(ctx: Ctx, factory: BackendFactory, body: Record<string, unknown>): Promise<Response> {
  const question = String(body.question ?? body.query ?? "").trim();
  if (!question) {
    return sseResponse(async function* () {
      yield JSON.stringify({ error: "question required" });
    });
  }
  const backend = await backendFor(ctx, factory);
  const filters = body.filters as any;

  return sseResponse(async function* () {
    if (backend.chatStream) {
      for await (const delta of backend.chatStream(question, filters)) {
        if (delta) yield JSON.stringify({ delta });
      }
    } else {
      // Backend can't stream — emit the whole answer as one event.
      const r = await backend.chat(question, filters);
      yield JSON.stringify({ delta: r.answer });
    }
  });
}

/** Wrap an async generator of JSON payload strings as an SSE Response. */
function sseResponse(gen: () => AsyncIterable<string>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const payload of gen()) {
          controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
        }
      } catch (err) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: String(err) })}\n\n`));
      } finally {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}

export async function routeIndex(ctx: Ctx, factory: BackendFactory, body: Record<string, unknown>) {
  const collectionId = String(body.collectionId ?? "").trim();
  if (!collectionId) return { error: "collectionId required" };
  const backend = await backendFor(ctx, factory);
  if (!backend.indexCollection) return { error: "backend does not support manual indexing" };
  return backend.indexCollection(collectionId, String(body.collectionName ?? collectionId));
}

export async function routeSync(ctx: Ctx, factory: BackendFactory) {
  const settings = await loadSettings(ctx);
  const backend = await backendFor(ctx, factory);
  if (!backend.indexCollection) return { ok: true, collections: [], note: "backend indexes automatically" };
  for (const id of settings.selectedCollections) {
    try {
      await backend.indexCollection(id);
    } catch (err) {
      ctx.log.error("[RAG] sync failed", { collection: id, err: String(err) });
    }
  }
  return { ok: true, collections: settings.selectedCollections };
}

export async function routeStatus(ctx: Ctx, factory: BackendFactory) {
  const backend = await backendFor(ctx, factory);
  return { backend: backend.kind, collections: await backend.status() };
}

// ── Backfill (resumable, cron-drained) ────────────────────────────────────────

async function backfillFor(ctx: Ctx, factory: BackendFactory): Promise<BackfillService> {
  return new BackfillService(ctx, await backendFor(ctx, factory));
}

/** Start a backfill over the selected collections (admin action). */
export async function startBackfill(ctx: Ctx, factory: BackendFactory) {
  const settings = await loadSettings(ctx);
  const svc = await backfillFor(ctx, factory);
  const job = await svc.start(settings.selectedCollections);
  return { started: true, collections: settings.selectedCollections, job };
}

export async function cancelBackfill(ctx: Ctx, factory: BackendFactory) {
  const svc = await backfillFor(ctx, factory);
  await svc.cancel();
  return { cancelled: true };
}

export async function backfillStatus(ctx: Ctx, factory: BackendFactory) {
  const svc = await backfillFor(ctx, factory);
  return svc.status();
}

/**
 * Cron drainer — call from the `cron` hook. Processes one bounded batch of the
 * active backfill job, if any. No-ops when idle. Bounded work per tick keeps it
 * within the runtime's CPU/wall-time limits regardless of blog size.
 */
export async function onCron(ctx: Ctx, factory: BackendFactory, cronName: string): Promise<void> {
  if (cronName !== BACKFILL_CRON) return;
  try {
    const svc = await backfillFor(ctx, factory);
    await svc.processBatch();
  } catch (err) {
    ctx.log.error("[backfill] cron drain failed", { err: String(err) });
  }
}
