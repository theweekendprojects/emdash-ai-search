/**
 * Shared plugin core — hook + route logic, identical in native and sandboxed
 * modes.
 *
 * There is ONE backend: Cloudflare AI Search (managed). Content is pushed into
 * the instance's built-in storage via the Items API (indexed immediately per
 * file — no R2, no Vectorize, no crawl, no sync job). Search and chat are served
 * by Cloudflare's own public-endpoint UI snippets (bubble / search / chat page),
 * which this plugin injects site-wide; the plugin no longer ships its own chat
 * route or widget.
 *
 * A `BackendFactory` (per entry point — sandboxed REST vs native binding) builds
 * the `SearchBackend` used for indexing.
 */

import type { Ctx } from "./services/host";
import type { SearchBackend } from "./services/search-backend";
import { DEFAULT_SETTINGS, type SearchSettings } from "./services/types";
import { BackfillService } from "./services/backfill.service";
import { buildSnippetFragments, chatPageHtml, type PageFragment } from "./snippets";

export type { PageFragment } from "./snippets";

/** Cron schedule name for the backfill drainer. */
export const BACKFILL_CRON = "ai-search-backfill";

/** Builds the SearchBackend for a given ctx + settings. Per entry point. */
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
  return {
    cfAccountId: await get("cfAccountId", DEFAULT_SETTINGS.cfAccountId),
    cfApiToken: await get("cfApiToken", DEFAULT_SETTINGS.cfApiToken),
    resultsLimit: Number(await get("resultsLimit", DEFAULT_SETTINGS.resultsLimit)),
    selectedCollections,
    aiSearchInstance: await get("aiSearchInstance", DEFAULT_SETTINGS.aiSearchInstance),
    // Public endpoint + UI snippets (the site-facing search/chat UI)
    publicEndpointUrl: await get("publicEndpointUrl", DEFAULT_SETTINGS.publicEndpointUrl),
    showChatBubble: (await get<boolean>("showChatBubble", DEFAULT_SETTINGS.showChatBubble)) !== false,
    showSearchModal: (await get<boolean>("showSearchModal", DEFAULT_SETTINGS.showSearchModal)) === true,
    snippetTheme: (await get("snippetTheme", DEFAULT_SETTINGS.snippetTheme)) as SearchSettings["snippetTheme"],
    snippetAccent: await get("snippetAccent", DEFAULT_SETTINGS.snippetAccent),
  };
}

export async function indexDraftsEnabled(ctx: Ctx): Promise<boolean> {
  return (await ctx.kv.get<boolean>("settings:indexDrafts")) === true;
}

/**
 * Whether a collection is opted into indexing. If the operator hasn't selected
 * any collections yet (fresh install), index everything — otherwise a brand-new
 * site would silently index nothing. Once they narrow the list, we honor it.
 */
function isIndexedCollection(settings: SearchSettings, collection: string): boolean {
  if (settings.selectedCollections.length === 0) return true;
  return settings.selectedCollections.includes(collection);
}

async function backendFor(ctx: Ctx, factory: BackendFactory): Promise<SearchBackend> {
  return factory.build(ctx, await loadSettings(ctx));
}

// ── Hook bodies (shared) ────────────────────────────────────────────────────

export async function onInstall(ctx: Ctx): Promise<void> {
  const defaults: Record<string, unknown> = {
    "settings:resultsLimit": DEFAULT_SETTINGS.resultsLimit,
    "settings:selectedCollections": "[]",
    "settings:indexDrafts": false,
    "settings:aiSearchInstance": DEFAULT_SETTINGS.aiSearchInstance,
    "settings:publicEndpointUrl": DEFAULT_SETTINGS.publicEndpointUrl,
    "settings:showChatBubble": DEFAULT_SETTINGS.showChatBubble,
    "settings:showSearchModal": DEFAULT_SETTINGS.showSearchModal,
    "settings:snippetTheme": DEFAULT_SETTINGS.snippetTheme,
    "settings:snippetAccent": DEFAULT_SETTINGS.snippetAccent,
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
  const settings = await loadSettings(ctx);
  if (!isIndexedCollection(settings, collection)) return;
  const backend = factory.build(ctx, settings);
  await backend.indexDocument(collection, contentId);
}

export async function onAfterSave(ctx: Ctx, factory: BackendFactory, collection: string, contentId: string): Promise<void> {
  if (!(await indexDraftsEnabled(ctx))) return;
  const settings = await loadSettings(ctx);
  if (!isIndexedCollection(settings, collection)) return;
  const backend = factory.build(ctx, settings);
  await backend.indexDocument(collection, contentId);
}

export async function onRemove(ctx: Ctx, factory: BackendFactory, collection: string, contentId: string): Promise<void> {
  // Always honor removals regardless of selection — a collection may have been
  // de-selected AFTER items were indexed, and unpublish/delete must still purge.
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

// ── Site-wide UI snippet injection (page:fragments) ──────────────────────────

/**
 * Build the fragments that inject Cloudflare's AI Search UI snippets (a floating
 * chat bubble and/or a Cmd/Ctrl+K search modal) on EVERY public page, so a site
 * author gets working search + chat with zero source edits.
 *
 * Returns null on admin (`/_emdash/`) paths or when no public endpoint URL is
 * configured. The heavy lifting (which components, the script tag, styling) is
 * in ./snippets so it stays testable and free of the runtime.
 */
export async function buildPageFragments(ctx: Ctx, pagePath: string): Promise<PageFragment[] | null> {
  if (typeof pagePath === "string" && pagePath.startsWith("/_emdash/")) return null;
  const settings = await loadSettings(ctx);
  return buildSnippetFragments(settings);
}

/**
 * Full-page chat UI route. Serves an HTML document that renders Cloudflare's
 * `<chat-page-snippet>` pointed at the configured public endpoint. Returns a raw
 * `Response` (native route). If no endpoint is configured, returns a short note.
 */
export async function routeChatPage(ctx: Ctx): Promise<Response> {
  const settings = await loadSettings(ctx);
  const siteTitle = ((ctx as any).site?.name as string) || "Chat";
  const html = chatPageHtml(settings, siteTitle);
  if (!html) {
    return new Response(
      "AI Search chat is not configured yet. Set the public endpoint URL in the plugin settings.",
      { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

export async function routeIndex(ctx: Ctx, factory: BackendFactory, body: Record<string, unknown>) {
  const collectionId = String(body.collectionId ?? "").trim();
  if (!collectionId) return { error: "collectionId required" };
  const backend = await backendFor(ctx, factory);
  if (!backend.indexCollection) return { error: "backend does not support manual indexing" };
  const force = body.force === true;
  return backend.indexCollection(collectionId, String(body.collectionName ?? collectionId), { force });
}

export async function routeSync(ctx: Ctx, factory: BackendFactory, opts?: { force?: boolean }) {
  const settings = await loadSettings(ctx);
  const backend = await backendFor(ctx, factory);
  if (!backend.indexCollection) return { ok: true, collections: [], note: "backend indexes automatically" };
  for (const id of settings.selectedCollections) {
    try {
      await backend.indexCollection(id, id, { force: opts?.force === true });
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
export async function startBackfill(ctx: Ctx, factory: BackendFactory, opts?: { force?: boolean }) {
  const settings = await loadSettings(ctx);
  const svc = await backfillFor(ctx, factory);
  const job = await svc.start(settings.selectedCollections, { force: opts?.force === true });
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
 *
 * We drain on ANY cron tick, not only our own named task. The host fires the
 * `cron` hook on the site's schedule (e.g. the `* * * * *` trigger in
 * wrangler.jsonc); relying solely on a self-scheduled `ctx.cron.schedule()`
 * task is fragile because `ctx.cron` is absent in some runtimes, which would
 * leave a started backfill wedged forever. `processBatch()` is a cheap no-op
 * when there is no active job, so an unconditional call is safe. When our own
 * named task IS present we still honor it; any other tick just opportunistically
 * advances a pending backfill.
 */
export async function onCron(ctx: Ctx, factory: BackendFactory, _cronName: string): Promise<void> {
  try {
    const svc = await backfillFor(ctx, factory);
    await svc.processBatch();
  } catch (err) {
    ctx.log.error("[backfill] cron drain failed", { err: String(err) });
  }
}
