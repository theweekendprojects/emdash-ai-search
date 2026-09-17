/**
 * emdash-ai-search — NATIVE entry (src/native.ts).
 *
 * Trusted (native) plugin. Runs in the host Worker isolate, so it can read the
 * Cloudflare bindings directly — NO API token, exactly like the Cloudflare
 * Email plugin reads its `send_email` binding. See README "Mode B: Native +
 * bindings".
 *
 * Bindings are read from `cloudflare:workers`:
 *   env.AI         → Workers AI  (embeddings)
 *   env.VECTORIZE  → Vectorize   (vector store)
 *
 * Same hook/route BODIES as the sandboxed entry (imported from ./core); only
 * the transport factory differs (BindingTransportFactory).
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
// NB: hook/route bodies below still come from ./core; only names/ids changed.
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
  routeChat,
  routeChatStream,
} from "./core";
import { handleAdmin } from "./admin";

/**
 * Build the native backend factory from `cloudflare:workers` env. It reads
 * whatever bindings are present; the factory validates the ones the SELECTED
 * backend needs at build time (AI Search needs AI_SEARCH + R2; Vectorize needs
 * AI + VECTORIZE). So a site only has to configure the bindings for the backend
 * it actually uses.
 */
function bindingFactory(): NativeBackendFactory {
  const e = env as unknown as NativeBindings;
  return new NativeBackendFactory({
    AI: e.AI,
    VECTORIZE: e.VECTORIZE,
    AI_SEARCH: e.AI_SEARCH,
    R2: e.R2,
  });
}

const asCtx = (ctx: unknown) => ctx as Ctx;

export function createPlugin() {
  return definePlugin({
    id: "ai-search",
    version: "0.4.0",

    admin: {
      entry: "emdash-ai-search/admin",
      pages: [{ path: "/", label: "AI Search", icon: "magnifying-glass" }],
      widgets: [{ id: "ai-search-status", title: "AI Search Index", size: "half" }],
      // Front-end injectable chatbot: appears in the editor's "/" slash menu.
      // Rendered on the site by src/astro/ChatWidget.astro (wired via the
      // descriptor's componentsEntry in aiSearch()).
      portableTextBlocks: [
        {
          type: "chat-widget",
          label: "AI Chat",
          icon: "link",
          description: "Embed the AI chatbot on this page.",
          fields: [
            { type: "text_input", action_id: "title", label: "Panel title" },
            { type: "text_input", action_id: "placeholder", label: "Input placeholder" },
            { type: "text_input", action_id: "welcome", label: "Welcome message" },
            { type: "text_input", action_id: "collections", label: 'Scope to collections (JSON array, optional)' },
            { type: "text_input", action_id: "accent", label: "Accent color (hex)" },
            {
              type: "select",
              action_id: "mode",
              label: "Display mode",
              options: [
                { label: "Floating button", value: "floating" },
                { label: "Inline panel", value: "inline" },
              ],
            },
          ],
        },
      ],
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
    },

    routes: {
      search: {
        public: true,
        handler: async (routeCtx: any, ctx: any) => routeSearch(asCtx(ctx), bindingFactory(), routeCtx.input ?? {}),
      },
      chat: {
        public: true,
        handler: async (routeCtx: any, ctx: any) => routeChat(asCtx(ctx), bindingFactory(), routeCtx.input ?? {}),
      },
      // Native-only: SSE streaming chat. Returns a raw Response, which only works
      // in the host isolate (native), not through the sandbox route bridge.
      "chat/stream": {
        public: true,
        handler: async (routeCtx: any, ctx: any) => routeChatStream(asCtx(ctx), bindingFactory(), routeCtx.input ?? {}),
      },
      index: {
        handler: async (routeCtx: any, ctx: any) => routeIndex(asCtx(ctx), bindingFactory(), routeCtx.input ?? {}),
      },
      sync: {
        handler: async (_routeCtx: any, ctx: any) => routeSync(asCtx(ctx), bindingFactory()),
      },
      status: {
        handler: async (_routeCtx: any, ctx: any) => routeStatus(asCtx(ctx), bindingFactory()),
      },
      admin: {
        handler: async (routeCtx: any, ctx: any) => handleAdmin(asCtx(ctx), bindingFactory(), routeCtx.input),
      },
    },
  });
}

export default createPlugin();
