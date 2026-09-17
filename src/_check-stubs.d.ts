/**
 * Type stubs for OFFLINE typechecking only (tsconfig.check.json). The real
 * `emdash`, `emdash/plugin`, and `cloudflare:workers` modules aren't installed
 * in this scratch copy. Not shipped.
 */
declare module "emdash/plugin" {
  export interface SandboxedPlugin {
    hooks?: Record<string, { handler: (event: any, ctx: any) => Promise<unknown> | unknown }>;
    routes?: Record<
      string,
      { public?: boolean; handler: (routeCtx: any, ctx: any) => Promise<unknown> | unknown }
    >;
    storage?: Record<string, { indexes?: (string | string[])[] }>;
  }
}

declare module "emdash" {
  export function definePlugin(config: unknown): unknown;
  export interface PluginDescriptor<T = Record<string, unknown>> {
    id: string;
    version: string;
    format?: string;
    entrypoint?: string;
    componentsEntry?: string;
    adminEntry?: string;
    capabilities?: string[];
    allowedHosts?: string[];
    storage?: Record<string, { indexes?: (string | string[])[]; uniqueIndexes?: (string | string[])[] }>;
    adminPages?: { path: string; label: string; icon?: string }[];
    adminWidgets?: { id: string; title?: string; size?: string }[];
    options?: T;
  }
}

// Astro SFC import — tsc can't parse .astro; declare it as an opaque component.
declare module "*.astro" {
  const component: unknown;
  export default component;
}

declare module "cloudflare:workers" {
  export const env: Record<string, unknown>;
}
