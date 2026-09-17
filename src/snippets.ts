/**
 * Cloudflare AI Search UI snippet injection.
 *
 * Instead of shipping our own chat UI, we inject Cloudflare's official,
 * open-source web components (https://github.com/cloudflare/ai-search-snippet):
 *   - <chat-bubble-snippet>  — a floating chat bubble in the page corner
 *   - <search-modal-snippet> — a Cmd/Ctrl+K search modal
 *   - <chat-page-snippet>    — a full chat page (rendered by the /ai-chat route)
 *
 * They connect to the instance's PUBLIC ENDPOINT via the `api-url` attribute.
 * The endpoint is enabled once in the Cloudflare dashboard and its URL pasted
 * into the plugin's admin settings; everything else is automatic.
 *
 * Pure string builders (no runtime deps) so they're easy to test.
 */

import type { SearchSettings } from "./services/types";

/** A page:fragments contribution (subset of EmDash's shape that we emit). */
export type PageFragment =
  | {
      kind: "external-script";
      placement: "head" | "body:start" | "body:end";
      src: string;
      async?: boolean;
      defer?: boolean;
      attributes?: Record<string, string>;
      key: string;
    }
  | { kind: "inline-script"; placement: "head" | "body:start" | "body:end"; code: string; key: string }
  | { kind: "html"; placement: "head" | "body:start" | "body:end"; html: string; key: string };

/** Pinned snippet asset version (the path is version-locked by Cloudflare). */
export const SNIPPET_VERSION = "v0.0.25";

/** HTML-escape a value for safe interpolation into attribute values. */
function attr(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Normalize the configured public endpoint into `https://<id>.search.ai.cloudflare.com/`
 * (or a custom domain). Returns null if it doesn't look like a URL.
 * Accepts a bare id, a host, or a full URL.
 */
export function normalizeEndpoint(raw: string): string | null {
  const v = (raw ?? "").trim();
  if (!v) return null;
  let url: URL;
  try {
    if (/^https?:\/\//i.test(v)) url = new URL(v);
    else if (v.includes(".")) url = new URL(`https://${v}`);
    else url = new URL(`https://${v}.search.ai.cloudflare.com`);
  } catch {
    return null;
  }
  // The snippet's api-url wants an origin with a trailing slash.
  return url.origin + "/";
}

/** The snippet library script URL for a given endpoint origin. */
export function snippetScriptSrc(endpointOrigin: string): string {
  return `${endpointOrigin}assets/${SNIPPET_VERSION}/search-snippet.es.js`;
}

/**
 * Build the page:fragments that mount Cloudflare's snippets site-wide. Returns
 * null when no valid public endpoint is configured or when every component is
 * disabled (nothing to inject).
 */
export function buildSnippetFragments(settings: SearchSettings): PageFragment[] | null {
  const endpoint = normalizeEndpoint(settings.publicEndpointUrl);
  if (!endpoint) return null;
  if (!settings.showChatBubble && !settings.showSearchModal) return null;

  const theme = settings.snippetTheme || "auto";
  const accent = settings.snippetAccent || "";
  // Accent color is applied via the documented --search-snippet-* CSS var.
  const styleTag = accent
    ? `<style>chat-bubble-snippet,search-modal-snippet{--search-snippet-primary-color:${attr(accent)};}</style>`
    : "";

  let markup = styleTag;
  if (settings.showChatBubble) {
    markup += `<chat-bubble-snippet api-url="${attr(endpoint)}" theme="${attr(theme)}"></chat-bubble-snippet>`;
  }
  if (settings.showSearchModal) {
    markup += `<search-modal-snippet api-url="${attr(endpoint)}" theme="${attr(theme)}" placeholder="Search…"></search-modal-snippet>`;
  }

  return [
    {
      kind: "external-script",
      placement: "body:end",
      src: snippetScriptSrc(endpoint),
      attributes: { type: "module" },
      key: "cf-ai-search-snippet-lib",
    },
    {
      kind: "html",
      placement: "body:end",
      html: markup,
      key: "cf-ai-search-snippet-markup",
    },
  ];
}

/**
 * Full HTML for the standalone chat page (served by the /ai-chat route). Renders
 * Cloudflare's <chat-page-snippet>. Returns null if no endpoint is configured.
 */
export function chatPageHtml(settings: SearchSettings, siteTitle = "Chat"): string | null {
  const endpoint = normalizeEndpoint(settings.publicEndpointUrl);
  if (!endpoint) return null;
  const theme = settings.snippetTheme || "auto";
  const accent = settings.snippetAccent
    ? `chat-page-snippet{--search-snippet-primary-color:${attr(settings.snippetAccent)};}`
    : "";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>${attr(siteTitle)}</title>
    <script type="module" src="${attr(snippetScriptSrc(endpoint))}"></script>
    <style>html,body{margin:0;height:100%}chat-page-snippet{display:block;height:100vh}${accent}</style>
  </head>
  <body>
    <chat-page-snippet api-url="${attr(endpoint)}" theme="${attr(theme)}"></chat-page-snippet>
  </body>
</html>`;
}
