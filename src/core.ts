/**
 * Shared plugin core — hook + route logic that is IDENTICAL in both modes and
 * across both backends.
 *
 * The seam: everything here talks to a `SearchBackend` (search/chat/index/remove).
 * A `BackendFactory` (supplied per entry point — sandboxed vs native) builds the
 * right SearchBackend based on the `kbBackend` setting:
 *   - "ai-search" (default) → AiSearchBackend (managed)
 *   - "vectorize"           → VectorizeBackend (self-managed pipeline)
 *
 * Sandboxed entry → REST transports; native entry → binding transports. Neither
 * this file nor the hooks/routes know which backend or transport is in play.
 */

import type { Ctx } from "./services/host";
import type { SearchBackend } from "./services/search-backend";
import { DEFAULT_SETTINGS, type SearchSettings } from "./services/types";
import { BackfillService } from "./services/backfill.service";

/** Cron schedule name for the backfill drainer. */
export const BACKFILL_CRON = "ai-search-backfill";

/** Builds the selected SearchBackend for a given ctx + settings. Per entry point. */
export interface BackendFactory {
  build(ctx: Ctx, settings: SearchSettings): SearchBackend;
}

export async function loadSettings(ctx: Ctx): Promise<SearchSettings> {
  const get = async <T>(k: string, d: T): Promise<T> => ((await ctx.kv.get<T>(`settings:${k}`)) ?? d);
  let selectedCollections: string[] = [];
  try {
    const raw = await get<string>("selectedCollections", "[]");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) selectedCollections = parsed.map(String);
  } catch {
    selectedCollections = [];
  }
  const backend = (await get<string>("kbBackend", DEFAULT_SETTINGS.kbBackend)) as SearchSettings["kbBackend"];
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
    // Security settings
    chatRateLimitPerMin: Number(await get("chatRateLimitPerMin", DEFAULT_SETTINGS.chatRateLimitPerMin)),
    chatRateLimitPerDay: Number(await get("chatRateLimitPerDay", DEFAULT_SETTINGS.chatRateLimitPerDay)),
    enableTurnstile: (await get<boolean>("enableTurnstile", DEFAULT_SETTINGS.enableTurnstile)) === true,
    turnstileSiteKey: await get("turnstileSiteKey", DEFAULT_SETTINGS.turnstileSiteKey),
  };
}

export async function indexDraftsEnabled(ctx: Ctx): Promise<boolean> {
  return (await ctx.kv.get<boolean>("settings:indexDrafts")) === true;
}

async function backendFor(ctx: Ctx, factory: BackendFactory): Promise<SearchBackend> {
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
    // Security settings
    "settings:chatRateLimitPerMin": DEFAULT_SETTINGS.chatRateLimitPerMin,
    "settings:chatRateLimitPerDay": DEFAULT_SETTINGS.chatRateLimitPerDay,
    "settings:enableTurnstile": DEFAULT_SETTINGS.enableTurnstile,
    "settings:turnstileSiteKey": DEFAULT_SETTINGS.turnstileSiteKey,
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

/**
 * Chat endpoint with security hardening:
 * - Origin/Referer validation (403 if not allowed)
 * - Per-IP rate limiting (429 if exceeded)
 * - Optional Turnstile verification
 */
export async function routeChat(ctx: Ctx, factory: BackendFactory, body: Record<string, unknown>) {
  const settings = await loadSettings(ctx);

  // NOTE: EmDash wraps every route return in `{ success: true, data: <value> }`
  // and serves it with the route's *successful* HTTP status — a sandboxed/native
  // route CANNOT choose 403/429 by returning a `status` field (verified against
  // the EmDash API-routes contract). So we return a stable application-level
  // `{ error, code }` that the widget detects, rather than a fake `status`.

  // Layer 1: Origin/Referer validation (belt-and-braces; core CSRF already 403s
  // cross-origin callers before we get here).
  if (!validateOrigin(ctx)) {
    return { error: "This chat only works from the site itself.", code: "FORBIDDEN_ORIGIN" };
  }

  // Layer 2: Rate limiting
  const rateLimitResult = await checkRateLimit(ctx, settings);
  if (rateLimitResult.exceeded) {
    return { error: "Too many requests — please slow down.", code: "RATE_LIMITED" };
  }

  // Layer 3: Turnstile verification (opt-in)
  if (settings.enableTurnstile) {
    const turnstileResult = await verifyTurnstile(ctx, settings);
    if (!turnstileResult.verified) {
      return { error: "Verification failed.", code: "TURNSTILE_FAILED" };
    }
  }

  const question = String(body.question ?? body.query ?? "").trim();
  if (!question) return { error: "question required", code: "BAD_REQUEST" };
  const backend = await backendFor(ctx, factory);
  return backend.chat(question, body.filters as any);
}

/**
 * Native-only streaming chat. Returns a real SSE `Response` (`data: {delta}` +
 * `[DONE]`). Do NOT wire this into a sandboxed route — the sandbox bridge wraps
 * route results in a JSON envelope and refuses raw Responses (per EmDash docs),
 * so streaming only works from the host isolate (native mode). Falls back to a
 * single JSON `data:` event if the backend can't stream.
 */
export async function routeChatStream(ctx: Ctx, factory: BackendFactory, body: Record<string, unknown>): Promise<Response> {
  const settings = await loadSettings(ctx);

  // Layer 1: Origin/Referer validation (see routeChat note).
  if (!validateOrigin(ctx)) {
    return sseResponse(async function* () {
      yield JSON.stringify({ error: "This chat only works from the site itself." });
    });
  }

  // Layer 2: Rate limiting
  const rateLimitResult = await checkRateLimit(ctx, settings);
  if (rateLimitResult.exceeded) {
    return sseResponse(async function* () {
      yield JSON.stringify({ error: "Too many requests — please slow down." });
    });
  }

  // Layer 3: Turnstile verification (opt-in)
  if (settings.enableTurnstile) {
    const turnstileResult = await verifyTurnstile(ctx, settings);
    if (!turnstileResult.verified) {
      return sseResponse(async function* () {
        yield JSON.stringify({ error: "Verification failed." });
      });
    }
  }

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

/**
 * Validate Origin/Referer against the site origin (defence in depth).
 *
 * NOTE: EmDash core already rejects cross-origin requests to public plugin
 * routes with a CSRF_REJECTED 403 *before* this handler runs (verified live:
 * a forged `Origin` on /chat and /search both 403 at the core layer). This
 * function is a belt-and-braces second check, so it MUST fail OPEN whenever the
 * request/site metadata is missing or ambiguous — otherwise it would wrongly
 * block the legitimate same-origin traffic that core already let through.
 *
 * The plugin context exposes headers as a plain `Record<string,string>` with
 * lowercased keys (there is NO `.get()` — that was a bug), the request on
 * `ctx.request`, and the site on `ctx.site` (NOT `ctx.env.site`).
 */
function validateOrigin(ctx: Ctx): boolean {
  const site = (ctx as any).site ?? ctx.env?.site;
  const siteUrl: string | undefined = site?.url;
  if (!siteUrl) return true; // No site config → allow (fail open).

  let allowedOrigin: string;
  try {
    allowedOrigin = new URL(siteUrl).origin;
  } catch {
    return true; // Unparseable site url → don't block.
  }

  const headers = (ctx as any).request?.headers as Record<string, string> | undefined;
  if (!headers) return true; // No headers surface → fail open.

  const readHeader = (name: string): string | undefined => {
    if (typeof (headers as any).get === "function") return (headers as any).get(name) ?? undefined; // tolerate a real Headers instance
    return headers[name] ?? headers[name.toLowerCase()];
  };

  const origin = readHeader("origin");
  const referer = readHeader("referer");

  // If neither header is present, this is likely a same-origin or
  // server-to-server call that core already vetted — allow.
  if (!origin && !referer) return true;

  for (const candidate of [origin, referer]) {
    if (!candidate) continue;
    try {
      if (new URL(candidate).origin === allowedOrigin) return true;
    } catch {
      // ignore invalid header value
    }
  }

  return false;
}

/**
 * Best-effort client IP for rate-limit bucketing. requestMeta shape isn't
 * strictly documented, so probe common fields and fall back to the
 * cf-connecting-ip header (Cloudflare) before "unknown".
 */
function clientIp(ctx: Ctx): string {
  const meta = (ctx as any).requestMeta ?? {};
  const fromMeta = meta.ip || meta.remoteAddress || meta.clientIp || meta.cf?.ip;
  if (fromMeta) return String(fromMeta);
  const headers = (ctx as any).request?.headers as Record<string, string> | undefined;
  if (headers) {
    const h =
      headers["cf-connecting-ip"] || headers["x-real-ip"] || headers["x-forwarded-for"];
    if (h) return String(h).split(",")[0].trim();
  }
  return (ctx as any).ip || "unknown";
}

/** Check per-IP rate limit (Layer 2 security). */
async function checkRateLimit(ctx: Ctx, settings: SearchSettings): Promise<{ exceeded: boolean }> {
  try {
    const ip = clientIp(ctx);
    const storage = ctx.storage?.rate_limit;
    if (!storage) {
      // Storage collection not provisioned (descriptor/manifest mismatch). Don't
      // crash the request; log so the misconfiguration is visible.
      ctx.log.warn("[ai-search] rate_limit storage missing — skipping rate limit");
      return { exceeded: false };
    }

    const now = Math.floor(Date.now() / 1000);
    const minuteWindowStart = Math.floor(now / 60) * 60;
    const dailyWindowStart = Math.floor(now / 86400) * 86400;

    const storageKey = `rate:${ip}`;

    // NOTE: we intentionally use plain get()/put() rather than the
    // getVersioned()/compareAndSet() conditional-write API. Although the EmDash
    // docs list those methods, they are NOT present on the deployed core
    // (verified live: "TypeError: storage.getVersioned is not a function" on
    // every request → the limiter used to fail open and never trip). get()/put()
    // exist on every version. The tiny race window under burst concurrency is an
    // acceptable trade for a soft anti-abuse limit.
    const record = ((await storage.get(storageKey)) as any) || {};
    let minuteCount = record.minuteWindowStart === minuteWindowStart ? record.minuteCount || 0 : 0;
    let dailyCount = record.dailyWindowStart === dailyWindowStart ? record.dailyCount || 0 : 0;

    minuteCount++;
    dailyCount++;

    if (minuteCount > settings.chatRateLimitPerMin || dailyCount > settings.chatRateLimitPerDay) {
      // Persist the incremented counters so the limit stays tripped for the window.
      await storage.put(storageKey, {
        ip,
        minuteCount,
        minuteWindowStart,
        dailyCount,
        dailyWindowStart,
        lastRequestAt: now,
      });
      return { exceeded: true };
    }

    await storage.put(storageKey, {
      ip,
      minuteCount,
      minuteWindowStart,
      dailyCount,
      dailyWindowStart,
      lastRequestAt: now,
    });
  } catch (err) {
    ctx.log.warn("[ai-search] rate limit check failed", { err: String(err) });
    // Fail open on rate limit errors (don't block legitimate requests)
  }

  return { exceeded: false };
}

/** Verify Turnstile token (Layer 3 security, opt-in). */
async function verifyTurnstile(ctx: Ctx, settings: SearchSettings): Promise<{ verified: boolean }> {
  try {
    const body = (ctx as any).input as Record<string, unknown>;
    const token = body?.turnstileToken as string;

    if (!token) {
      return { verified: false };
    }

    // Call Cloudflare Turnstile verify API
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        // NB: siteverify requires the Turnstile *secret* key, not the site key.
        // This reuses turnstileSiteKey for now (Turnstile is off by default and
        // untested end-to-end) — see review notes / README before enabling.
        secret: settings.turnstileSiteKey,
        response: token,
        remoteip: clientIp(ctx),
      }),
    });

    if (!response.ok) {
      return { verified: false };
    }

    const result = await response.json();
    return { verified: result.success === true };
  } catch (err) {
    ctx.log.warn("[ai-search] turnstile verification failed", { err: String(err) });
    return { verified: false };
  }
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
      ctx.log.error("[ai-search] sync failed", { collection: id, err: String(err) });
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
