/**
 * emdash-ai-search — NATIVE entry (src/native.ts).
 *
 * Trusted (native) plugin. Runs in the host Worker isolate, so it reads the
 * Cloudflare AI Search binding directly — NO API token.
 *
 * Binding read from `cloudflare:workers`:
 *   env.AI_SEARCH  → Cloudflare AI Search namespace (indexing via the Items API)
 *
 * The plugin's job is small:
 *   - index content into the AI Search instance's built-in storage on publish
 *     (indexed immediately per file — no R2, no Vectorize, no crawl/sync job)
 *   - inject Cloudflare's public-endpoint UI snippets (chat bubble / search
 *     modal) site-wide via page:fragments, plus a /ai-chat page
 *
 * NOTE: native plugins are trusted/local only — installed via `plugins: []` in
 * astro.config.mjs, NOT registry-installable. Requires Astro 6 +
 * @astrojs/cloudflare v13+ for the `cloudflare:workers` env import.
 */

// The `emdash` runtime + the cloudflare env import exist only in the host build.
// They are declared in _check-stubs.d.ts for offline typechecking.
import { definePlugin } from "emdash";
import { env } from "cloudflare:workers";
import type { Ctx } from "./services/host";
import { NativeBackendFactory, type NativeBindings } from "./backends";
import {
  onInstall,
  onActivate,
  onCron,
  onAfterPublish,
  onAfterSave,
  onRemove,
  routeSearch,
  routeIndex,
  routeSync,
  routeStatus,
  routeChatPage,
  buildPageFragments,
} from "./core";
import { handleAdmin } from "./admin";

/** Build the native backend factory from the `cloudflare:workers` AI Search binding. */
function bindingFactory(): NativeBackendFactory {
  const e = env as unknown as NativeBindings;
  return new NativeBackendFactory({ AI_SEARCH: e.AI_SEARCH });
}

const asCtx = (ctx: unknown) => ctx as Ctx;

export function createPlugin() {
  return definePlugin({
    id: "ai-search",
    version: "0.4.0",

    // Capabilities/storage MUST be declared here (in definePlugin) — this is what
    // grants the runtime ctx.kv / ctx.content and provisions storage. Declaring
    // them only on the build-time descriptor is NOT enough.
    //   - content:read                 → ctx.content.list()/get() + lifecycle hooks
    //   - network:request              → sandboxed REST path (harmless in native)
    //   - hooks.page-fragments:register → inject the Cloudflare UI snippets
    capabilities: ["content:read", "network:request", "hooks.page-fragments:register"],
    allowedHosts: ["api.cloudflare.com"],
    storage: {
      // Backfill needs a durable job record + per-doc content-hash dedup. The old
      // Vectorize collections (index_meta, chunk_map) and the chat rate_limit
      // collection are gone.
      backfill_job: { indexes: ["phase", "updatedAt"] },
      doc_state: { indexes: ["collectionId", "indexedAt"] },
    },

    admin: {
      entry: "emdash-ai-search/admin",
      pages: [{ path: "/", label: "AI Search", icon: "magnifying-glass" }],
      widgets: [{ id: "ai-search-status", title: "AI Search Index", size: "half" }],
    },

    hooks: {
      "plugin:install": { handler: async (_e: unknown, ctx: unknown) => onInstall(asCtx(ctx)) },
      "plugin:activate": { handler: async (_e: unknown, ctx: unknown) => onActivate(asCtx(ctx)) },
      cron: {
        handler: async (event: any, ctx: any) => onCron(asCtx(ctx), bindingFactory(), String(event?.name ?? "")),
      },

      "content:afterPublish": {
        handler: async (event: any, ctx: any) => {
          try {
            await onAfterPublish(asCtx(ctx), bindingFactory(), event.collection, String(event.content.id));
          } catch (err) {
            ctx.log.warn("[ai-search] afterPublish failed", { err: String(err) });
          }
        },
      },
      "content:afterSave": {
        handler: async (event: any, ctx: any) => {
          try {
            await onAfterSave(asCtx(ctx), bindingFactory(), event.collection, String(event.content.id));
          } catch (err) {
            ctx.log.warn("[ai-search] afterSave failed", { err: String(err) });
          }
        },
      },
      "content:afterUnpublish": {
        handler: async (event: any, ctx: any) => {
          try {
            await onRemove(asCtx(ctx), bindingFactory(), event.collection, String(event.content.id));
          } catch (err) {
            ctx.log.warn("[ai-search] afterUnpublish failed", { err: String(err) });
          }
        },
      },
      "content:afterDelete": {
        handler: async (event: any, ctx: any) => {
          try {
            await onRemove(asCtx(ctx), bindingFactory(), event.collection, String(event.id));
          } catch (err) {
            ctx.log.warn("[ai-search] afterDelete failed", { err: String(err) });
          }
        },
      },

      // Inject Cloudflare's AI Search UI snippets (chat bubble / search modal)
      // into every public page — no source edits by the site author.
      "page:fragments": {
        handler: async (event: any, ctx: any) => {
          try {
            return await buildPageFragments(asCtx(ctx), String(event?.page?.path ?? ""));
          } catch (err) {
            ctx.log.warn("[ai-search] page:fragments failed", { err: String(err) });
            return null;
          }
        },
      },
    },

    // NB: native ROUTE handlers receive the plugin context as the FIRST argument
    // (routeCtx), which carries ctx.kv/ctx.content AND .input.
    routes: {
      search: {
        public: true,
        handler: async (routeCtx: any) => routeSearch(asCtx(routeCtx), bindingFactory(), routeCtx.input ?? {}),
      },
      // Full-page chat UI (Cloudflare's <chat-page-snippet>). Public HTML page.
      "ai-chat": {
        public: true,
        handler: async (routeCtx: any) => routeChatPage(asCtx(routeCtx)),
      },
      index: {
        handler: async (routeCtx: any) => routeIndex(asCtx(routeCtx), bindingFactory(), routeCtx.input ?? {}),
      },
      sync: {
        handler: async (routeCtx: any) => routeSync(asCtx(routeCtx), bindingFactory()),
      },
      status: {
        handler: async (routeCtx: any) => routeStatus(asCtx(routeCtx), bindingFactory()),
      },
      admin: {
        handler: async (routeCtx: any) => handleAdmin(asCtx(routeCtx), bindingFactory(), routeCtx.input),
      },
    },
  });
}

export default createPlugin();
