/**
 * emdash-ai-search — NATIVE descriptor factory (build-time).
 *
 * Side-effect-free; imported from astro.config.mjs. The descriptor points at the
 * runtime entry (`native.ts` via ./native) and the site-side render components
 * (`./astro`) through `componentsEntry`, which is what makes the "AI Chat"
 * Portable Text block render on the published site.
 *
 * This is the NATIVE build's entry. The sandboxed build uses ./sandbox
 * (plugin.ts) and CANNOT ship Portable Text blocks — that's a native-only
 * feature per EmDash docs, which is exactly why the injectable widget lives here.
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
    componentsEntry: "emdash-ai-search/astro",
    adminEntry: "emdash-ai-search/admin",
    // Capabilities MUST be declared on the descriptor (like emdash-smtp does) or
    // EmDash grants the plugin a context without ctx.kv / ctx.content — which
    // caused "Cannot read properties of undefined (reading 'kv')" at runtime.
    //   - content:read    → ctx.content.list()/get() to pull items to index +
    //                       the content lifecycle hooks (afterPublish, etc.)
    //   - network:request → reserved for the sandboxed REST path; harmless here.
    capabilities: ["content:read", "network:request"],
    allowedHosts: ["api.cloudflare.com"],
    // Plugin-scoped storage collections (provisioned by the host). Same set the
    // sandboxed manifest declares.
    storage: {
      index_meta: { indexes: ["status", "lastSyncAt"] },
      chunk_map: { indexes: ["collectionId", "updatedAt"] },
      backfill_job: { indexes: ["phase", "updatedAt"] },
      doc_state: { indexes: ["collectionId", "indexedAt"] },
    },
    adminPages: [{ path: "/", label: "AI Search", icon: "magnifying-glass" }],
    adminWidgets: [{ id: "ai-search-status", title: "AI Search Index", size: "half" }],
    options,
  };
}

export default aiSearch;
