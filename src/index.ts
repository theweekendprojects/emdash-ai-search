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
    options,
  };
}

export default aiSearch;
