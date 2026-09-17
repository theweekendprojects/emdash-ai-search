/**
 * The two BackendFactory implementations — one per plugin runtime mode.
 *
 *   SandboxedBackendFactory → REST over ctx.http (needs CF account id + token).
 *   NativeBackendFactory     → the Cloudflare AI Search binding (env.AI_SEARCH
 *                              namespace). Tokenless.
 *
 * There is ONE backend: Cloudflare AI Search (managed). Content is pushed into
 * the instance's built-in storage via the Items API (indexed immediately per
 * file); search/chat query the instance directly.
 */

import type { Ctx } from "./services/host";
import type { SearchSettings } from "./services/types";
import type { SearchBackend } from "./services/search-backend";
import type { BackendFactory } from "./core";

import { AiSearchBackend } from "./services/ai-search-backend";
import { RestAiSearchClient } from "./services/ai-search-client";
import { BindingAiSearchClient, type AiSearchNamespaceBinding } from "./services/ai-search-client";

// ── Sandboxed (REST over ctx.http) ──────────────────────────────────────────

export class SandboxedBackendFactory implements BackendFactory {
  build(ctx: Ctx, settings: SearchSettings): SearchBackend {
    if (!ctx.http) throw new Error("AI search (sandboxed): network:request capability missing (ctx.http)");
    if (!settings.cfAccountId || !settings.cfApiToken) {
      throw new Error("AI search (sandboxed): Cloudflare account id / API token not set in Settings");
    }
    const client = new RestAiSearchClient(ctx.http, settings.cfAccountId, settings.cfApiToken, settings.aiSearchInstance);
    return new AiSearchBackend(ctx, client, { resultsLimit: settings.resultsLimit });
  }
}

// ── Native (Cloudflare bindings) ─────────────────────────────────────────────

/** The bindings the native entry reads from `cloudflare:workers`. */
export interface NativeBindings {
  AI_SEARCH?: AiSearchNamespaceBinding;
}

export class NativeBackendFactory implements BackendFactory {
  constructor(private bindings: NativeBindings) {}

  build(ctx: Ctx, settings: SearchSettings): SearchBackend {
    const b = this.bindings;
    if (!b.AI_SEARCH) {
      throw new Error("AI search (native): AI_SEARCH namespace binding missing (add [[ai_search_namespaces]] to wrangler config)");
    }
    const client = new BindingAiSearchClient(b.AI_SEARCH.get(settings.aiSearchInstance));
    return new AiSearchBackend(ctx, client, { resultsLimit: settings.resultsLimit });
  }
}
