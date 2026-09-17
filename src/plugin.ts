/**
 * emdash-ai-search — SANDBOXED entry (src/plugin.ts).
 *
 * Registry-installable sandboxed plugin. Embeddings + vectors go over the
 * Cloudflare REST APIs via ctx.http (RestTransportFactory), so it needs a CF
 * account id + API token in Settings. See README "Mode A: Sandboxed + REST".
 *
 * All hook/route BODIES live in ./core (shared with the native entry). This
 * file only maps EmDash's SandboxedPlugin shape onto those bodies.
 */

import type { SandboxedPlugin } from "emdash/plugin";
import type { Ctx } from "./services/host";
import { SandboxedBackendFactory } from "./backends";
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
} from "./core";
import { handleAdmin } from "./admin";

const factory = new SandboxedBackendFactory();
const asCtx = (ctx: unknown) => ctx as Ctx;

const plugin: SandboxedPlugin = {
  hooks: {
    "plugin:install": { handler: async (_e, ctx) => onInstall(asCtx(ctx)) },
    "plugin:activate": { handler: async (_e, ctx) => onActivate(asCtx(ctx)) },
    cron: {
      handler: async (event: any, ctx) => onCron(asCtx(ctx), factory, String(event?.name ?? "")),
    },

    "content:afterPublish": {
      handler: async (event, ctx) => {
        try {
          await onAfterPublish(asCtx(ctx), factory, event.collection, String(event.content.id));
        } catch (err) {
          ctx.log.warn("[ai-search] afterPublish failed", { err: String(err) });
        }
      },
    },
    // Optional draft indexing — no-ops unless settings.indexDrafts is true.
    "content:afterSave": {
      handler: async (event, ctx) => {
        try {
          await onAfterSave(asCtx(ctx), factory, event.collection, String(event.content.id));
        } catch (err) {
          ctx.log.warn("[ai-search] afterSave failed", { err: String(err) });
        }
      },
    },
    "content:afterUnpublish": {
      handler: async (event, ctx) => {
        try {
          await onRemove(asCtx(ctx), factory, event.collection, String(event.content.id));
        } catch (err) {
          ctx.log.warn("[ai-search] afterUnpublish failed", { err: String(err) });
        }
      },
    },
    "content:afterDelete": {
      handler: async (event, ctx) => {
        try {
          await onRemove(asCtx(ctx), factory, event.collection, String(event.id));
        } catch (err) {
          ctx.log.warn("[ai-search] afterDelete failed", { err: String(err) });
        }
      },
    },
  },

  routes: {
    search: {
      public: true,
      handler: async (routeCtx, ctx) => routeSearch(asCtx(ctx), factory, (routeCtx.input as any) ?? {}),
    },
    // Public chatbot: retrieve-then-generate over your content.
    chat: {
      public: true,
      handler: async (routeCtx, ctx) => routeChat(asCtx(ctx), factory, (routeCtx.input as any) ?? {}),
    },
    // Streaming chat — sandboxed routes can't return a raw Response stream,
    // so this route is omitted in sandboxed builds. The widget falls back to /chat.
    // index: {
    //   handler: async (routeCtx, ctx) => routeIndex(asCtx(ctx), factory, (routeCtx.input as any) ?? {}),
    // },
    sync: {
      handler: async (_routeCtx, ctx) => routeSync(asCtx(ctx), factory),
    },
    status: {
      handler: async (_routeCtx, ctx) => routeStatus(asCtx(ctx), factory),
    },
    // Block Kit admin panel: settings form + status table + backfill actions.
    admin: {
      handler: async (routeCtx, ctx) => handleAdmin(asCtx(ctx), factory, routeCtx.input),
    },
  },
  storage: {
    index_meta: { indexes: ["status", "lastSyncAt"] },
    chunk_map: { indexes: ["collectionId", "updatedAt"] },
    backfill_job: { indexes: ["phase", "updatedAt"] },
    doc_state: { indexes: ["collectionId", "indexedAt"] },
    // Rate limiting storage (new in v0.8)
    rate_limit: { indexes: ["ip", "minuteWindowStart", "dailyWindowStart"] },
  },
};

export default plugin;
