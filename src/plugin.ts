/**
 * emdash-ai-search — SANDBOXED entry (src/plugin.ts).
 *
 * Registry-installable sandboxed plugin. Indexing goes over the Cloudflare REST
 * API via ctx.http (needs a CF account id + API token in Settings). See README
 * "Mode A: Sandboxed + REST".
 *
 * The sandbox cannot register page:fragments or return a raw Response, so it
 * omits the UI-snippet injection and the /ai-chat page. To get the site-facing
 * search/chat UI in sandboxed mode, add Cloudflare's snippet <script> to your
 * layout manually (see README). The native entry (src/native.ts) injects it for
 * you.
 *
 * All hook/route BODIES live in ./core (shared with the native entry).
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
    sync: {
      handler: async (_routeCtx, ctx) => routeSync(asCtx(ctx), factory),
    },
    status: {
      handler: async (_routeCtx, ctx) => routeStatus(asCtx(ctx), factory),
    },
    index: {
      handler: async (routeCtx, ctx) => routeIndex(asCtx(ctx), factory, (routeCtx.input as any) ?? {}),
    },
    // Block Kit admin panel: settings form + backfill actions.
    admin: {
      handler: async (routeCtx, ctx) => handleAdmin(asCtx(ctx), factory, routeCtx.input),
    },
  },
  storage: {
    backfill_job: { indexes: ["phase", "updatedAt"] },
    doc_state: { indexes: ["collectionId", "indexedAt"] },
  },
};

export default plugin;
