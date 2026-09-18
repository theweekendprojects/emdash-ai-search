/**
 * emdash-ai-search — NATIVE descriptor factory (build-time).
 *
 * Side-effect-free; imported from astro.config.mjs. The descriptor points at the
 * runtime entry (`native.ts` via ./native) and the admin entry.
 *
 * The plugin indexes content into a Cloudflare AI Search instance (built-in
 * storage, per-file, on publish) and injects Cloudflare's public-endpoint UI
 * snippets (chat bubble / search modal) site-wide via a page:fragments hook.
 * There is no shipped Portable Text block, so there is no componentsEntry.
 */
import type { PluginDescriptor } from "emdash";

export interface AiSearchOptions extends Record<string, unknown> {
  id?: string;
}

export function aiSearch(options: AiSearchOptions = {}): PluginDescriptor<AiSearchOptions> {
  return {
    id: options.id ?? "ai-search",
    version: "0.4.0",
    format: "native",
    entrypoint: "emdash-ai-search/native",
    // NO adminEntry: this is a Block Kit admin (declarative blocks via the
    // `admin` route in native.ts). Declaring adminEntry flips EmDash to a React
    // admin (adminMode:"react") and the sidebar nav link never renders. Match
    // the Block Kit settings plugins (better-auth/smtp/seo) which omit it.
    // Capabilities MUST be declared on the descriptor (like emdash-smtp does) or
    // EmDash grants the plugin a context without ctx.kv / ctx.content.
    //   - content:read                 → ctx.content.list()/get() + lifecycle hooks
    //   - network:request              → sandboxed REST path (harmless in native)
    //   - hooks.page-fragments:register → inject the Cloudflare UI snippets site-wide
    // MUST match definePlugin() in native.ts.
    capabilities: ["content:read", "network:request", "hooks.page-fragments:register"],
    allowedHosts: ["api.cloudflare.com"],
    // Plugin-scoped storage (provisioned by the host). MUST match definePlugin()
    // (native.ts) and the sandboxed manifest (plugin.ts).
    storage: {
      backfill_job: { indexes: ["phase", "updatedAt"] },
      doc_state: { indexes: ["collectionId", "indexedAt"] },
    },
    adminPages: [{ path: "/settings", label: "AI Search", icon: "magnifying-glass" }],
    adminWidgets: [{ id: "ai-search-status", title: "AI Search Index", size: "half" }],
    options,
  };
}

export default aiSearch;
