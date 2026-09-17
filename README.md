# emdash-ai-search

Semantic search + grounded AI chat for [EmDash CMS](https://github.com/emdash-cms/emdash),
powered entirely by [Cloudflare AI Search](https://developers.cloudflare.com/ai-search/)
(the managed service, formerly AutoRAG).

The plugin does two small, well-scoped jobs:

1. **Indexes your content.** When you publish a page or post, the plugin uploads
   it to your AI Search instance's built-in storage. Cloudflare indexes each file
   **immediately, per file** — no R2 bucket, no crawl, no multi-hour sync. A
   publish is searchable within moments.
2. **Adds search + chat to your site.** It injects Cloudflare's own official UI
   snippets (a floating chat bubble and/or a `Cmd/Ctrl+K` search modal) on every
   public page. There is **no custom widget to build or style** — Cloudflare owns
   the UI, and you toggle/theme it from the plugin's admin page.

Everything else — chunking, embeddings, hybrid search, reranking, and answer
generation — is Cloudflare's managed service. That's the whole point: the site
maintainer does the least possible work.

> **Where the AI model is chosen:** on the **Cloudflare instance**, not in this
> plugin. AI Search uses a Workers AI model by default (zero config). To use a
> different or third-party model, configure it on the instance via AI Gateway
> (see [Choosing the generation model](#choosing-the-generation-model)). The
> plugin deliberately never sends a model override.

---

## What you need before you start

- A **Cloudflare account** with **AI Search** available.
- An EmDash site deployed to **Cloudflare Workers**, on **Astro 6 +
  `@astrojs/cloudflare` v13+** (required for the `cloudflare:workers` env import
  this native plugin uses).
- **Node 18+** and **wrangler** (`npx wrangler`).

This plugin runs as a **native (trusted) EmDash plugin** — installed via
`plugins: []` in `astro.config.mjs`. It is tokenless: it reaches AI Search
through a Workers binding, so there is no API token to store.

---

## Setup — step by step

The plugin can't do anything until a Cloudflare AI Search instance exists and its
public endpoint is on. Do these in order.

### 1. Create an AI Search instance

Use **built-in storage** (the plugin uploads files to it directly — no data
source to connect):

```sh
npx wrangler ai-search create my-search --type builtin
```

`my-search` is the instance name — remember it, you'll paste it into the plugin
admin. You can also create it from the dashboard: **Cloudflare dashboard → AI →
AI Search → Create**, choosing built-in storage.

### 2. (Optional) Choose the generation model

By default AI Search generates chat answers with a Workers AI model — you don't
have to do anything. To use a different model, configure it on the **instance**
(the plugin never overrides the model). See
[Choosing the generation model](#choosing-the-generation-model) below.

### 3. Enable the public endpoint

The chat/search UI snippets talk to the instance's public endpoint.

1. Dashboard → **AI Search → your instance → Settings → Public Endpoint**.
2. Turn on **Enable Public Endpoint**.
3. Copy the URL — it looks like
   `https://<id>.search.ai.cloudflare.com/`. You'll paste this into the plugin
   admin.

### 4. Allow your site's origin (CORS)

> **This is the most common setup mistake.** If your site origin isn't in the
> allowlist, the browser blocks the snippet and the bubble silently won't work.

In the same **Settings → Public Endpoint** panel, under **Authorized hosts**, add:

- your production origin, e.g. `https://example.com`
- (for local dev) your dev origin, e.g. `http://localhost:4321`

Save. Note this is a browser-side control, not access control — it stops other
sites embedding your snippet, not direct API calls.

### 5. Add the wrangler binding

Add the AI Search **namespace binding** to your site's `wrangler.jsonc`. The
binding **name must be `AI_SEARCH`** (that's what the plugin reads):

```jsonc
{
  "compatibility_date": "2026-03-27",
  "ai_search_namespaces": [
    { "binding": "AI_SEARCH", "namespace": "default" }
  ]
}
```

The instance must exist (step 1) before you deploy.

### 6. Install and register the plugin

```sh
pnpm add emdash-ai-search
```

In `astro.config.mjs`, register it as a **native** plugin (called as a factory):

```js
import emdash from "emdash/astro";
import aiSearch from "emdash-ai-search"; // default export = native descriptor

export default defineConfig({
  integrations: [
    emdash({
      plugins: [aiSearch()], // native plugins go in `plugins`, not `sandboxed`
    }),
  ],
});
```

Deploy your site (`wrangler deploy`, or your usual build+deploy).

### 7. Configure the plugin in admin

Open **EmDash Admin → Plugins → AI Search** and set:

- **AI Search instance name** — the name from step 1 (e.g. `my-search`).
- **Indexed collections** — a JSON array of the collections to index, e.g.
  `["posts","pages"]`. (Leave empty to index everything.)
- **Public endpoint URL** — the URL from step 3.
- **Show floating chat bubble** — on by default.
- **Show Cmd/Ctrl+K search modal** — optional.
- **Snippet theme** / **Accent color** — light/dark and primary color for the UI.

Save.

### 8. Verify

1. **Publish or re-index content.** Publish a post — it uploads and indexes
   within moments. For content that existed *before* you installed, click
   **Reindex "&lt;collection&gt;" now** in the admin.
2. **Load a public page.** The chat bubble should appear in the corner. Open it
   and ask a question about your content — you should get a grounded answer.
3. If the bubble doesn't appear, re-check **CORS (step 4)** and that the **public
   endpoint URL** is set.

---

## How indexing works

You never trigger indexing manually for new content. The plugin listens to
EmDash's content lifecycle:

| Event | What the plugin does |
|---|---|
| `content:afterPublish` | Uploads the page to AI Search built-in storage (indexed per file, immediately) |
| `content:afterSave` | Same — **only if "Also index drafts" is ON** |
| `content:afterUnpublish` | Deletes the item from the index |
| `content:afterDelete` | Deletes the item from the index |

Only **published** content is indexed unless you enable "Also index drafts".
Only collections in **Indexed collections** are indexed (empty = all). Documents
larger than AI Search's 4 MB per-item limit are truncated for indexing (with a
log warning).

### Indexing existing content (backfill)

Installed on a site that already has content? New content indexes on publish
automatically, but the existing archive needs a one-time pass:

- **Small collections:** click **Reindex "&lt;collection&gt;" now** in the admin
  (synchronous).
- **Large archives:** **Start backfill** seeds a resumable, batched job.

> **Known limitation:** the background backfill drainer depends on the `cron`
> hook, which isn't reliably dispatched in every native deployment, so a **Start
> backfill** job may not advance. New content is unaffected (it indexes on
> publish). Use **Reindex now** for existing collections meanwhile. Tracked in
> [#2](https://github.com/theweekendprojects/emdash-ai-search/issues/2).

---

## The search & chat UI (Cloudflare snippets)

Instead of shipping a widget, the plugin injects Cloudflare's official web
components on every public page via EmDash's `page:fragments` hook:

- `<chat-bubble-snippet>` — a floating chat bubble.
- `<search-modal-snippet>` — a `Cmd/Ctrl+K` search modal.

They load from your public endpoint and are entirely Cloudflare's UI. Nothing is
injected until you set the **Public endpoint URL**.

### Styling / color

Color and theme come from Cloudflare's snippet, and there are two layers:

- **Cloudflare dashboard configurator** — under **Settings → Public Endpoint**,
  Cloudflare provides a branding configurator (primary color, border radius,
  focus ring, etc.). These are the defaults baked into your endpoint.
- **Plugin admin overrides** — the **Accent color** field sets Cloudflare's
  `--search-snippet-primary-color` CSS variable at the page level, and the
  **Snippet theme** field sets `theme="auto|light|dark"`. A page-level override
  wins over the dashboard default; leave the accent blank to inherit the
  dashboard configuration.

Richer per-variable styling (a real color picker, border radius, hide-branding,
etc.) is tracked in
[#4](https://github.com/theweekendprojects/emdash-ai-search/issues/4).

---

## Settings reference

All settings live on the plugin admin page (**Admin → Plugins → AI Search**).

| Setting | What it does | Default |
|---|---|---|
| **AI Search instance name** | The instance the plugin targets | `emdash-ai-search` |
| **Indexed collections** | JSON array of collections to index; empty = all | `[]` |
| **Also index drafts** | Index on every save, not just publish | off |
| **Results per query** | Max results the plugin's own `/search` route requests | 20 |
| **Public endpoint URL** | The instance public endpoint the snippets use | — |
| **Show floating chat bubble** | Inject `<chat-bubble-snippet>` site-wide | on |
| **Show Cmd/Ctrl+K search modal** | Inject `<search-modal-snippet>` site-wide | off |
| **Snippet theme** | `auto` / `light` / `dark` | auto |
| **Accent color (hex)** | Overrides `--search-snippet-primary-color` | — |
| **Cloudflare Account ID / API Token** | *Sandboxed REST mode only* — unused in native; leave blank | — |

**Not configured here (set on the Cloudflare instance instead):** the generation
model, chunk size, and hybrid-search options. See below.

> The Cloudflare Account ID / API Token fields only apply to the experimental
> sandboxed REST mode. In the recommended native setup they are unused — leave
> them blank. Note EmDash's settings store is not encrypted at rest, which is one
> more reason the native (tokenless) path is preferred.

---

## Choosing the generation model

AI Search generates chat answers itself; the model is a property of the
**instance**, not this plugin.

- **Default:** a Workers AI model. No configuration needed.
- **Third-party model:** attach a provider key through **AI Gateway** and select
  the model in your AI Search instance settings. See Cloudflare's
  [Bring your own generation model](https://developers.cloudflare.com/ai-search/how-to/bring-your-own-generation-model/)
  guide.

The plugin intentionally does **not** send a model override to the managed
instance — doing so causes `AiSearchError: Internal Error`. Change the model on
Cloudflare's side and the chat bubble picks it up automatically.

---

## Routes

The plugin registers these routes under
`/_emdash/api/plugins/ai-search/`:

| Route | Method | Purpose |
|---|---|---|
| `search` | POST | Query the instance; returns ranked results. Public. |
| `ai-chat` | GET | Standalone chat page (Cloudflare's `<chat-page-snippet>`). Public. |
| `index` | POST | Reindex one collection (admin action). |
| `sync` | POST | Reindex all selected collections. |
| `status` | GET | Backend/status info for the admin. |
| `admin` | — | Drives the Block Kit admin panel. |

> **Known issue:** the `ai-chat` route currently returns a JSON envelope instead
> of raw HTML — the standalone chat page doesn't render yet. The **chat bubble**
> (injected site-wide) is the primary chat UX and works. Tracked in
> [#3](https://github.com/theweekendprojects/emdash-ai-search/issues/3).

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Chat bubble doesn't appear | Set the **Public endpoint URL** in admin; confirm your site origin is in **Authorized hosts** (CORS) on the instance. |
| Bubble appears but errors on send | Check CORS again; confirm **Enable Public Endpoint** is on and the URL is correct. |
| `AI_SEARCH namespace binding missing` | Add `ai_search_namespaces` (binding `AI_SEARCH`) to `wrangler.jsonc` and redeploy; the instance must exist first. |
| `cloudflare:workers` import fails to build | Upgrade to Astro 6 + `@astrojs/cloudflare` v13+. |
| New posts not searchable | Confirm the collection is in **Indexed collections**; give indexing a few moments. |
| Existing posts not indexed after install | Use **Reindex "&lt;collection&gt;" now**. (Bulk **Start backfill** may not drain — see [#2](https://github.com/theweekendprojects/emdash-ai-search/issues/2).) |
| Chat answers "I don't have that information" | That topic isn't indexed yet — publish/reindex the relevant content. |
| Want a different chat model | Set it on the Cloudflare instance (AI Gateway), not in the plugin. |

---

## How it works (architecture)

```
EmDash content lifecycle                Cloudflare AI Search (managed)
  publish/save/unpublish/delete   ─────▶  built-in storage (Items API)
        │                                   └ chunk + embed + index (per file, immediate)
        │
page:fragments hook  ───────────────────▶  inject <chat-bubble-snippet> / <search-modal-snippet>
        │                                   └ served from the instance public endpoint
        ▼
  admin settings (instance, endpoint, bubble/theme, collections)
```

Key files:

- `src/index.ts` — native descriptor factory `aiSearch()` (build-time).
- `src/native.ts` — native runtime entry (reads the `AI_SEARCH` binding).
- `src/plugin.ts` — sandboxed entry (experimental REST path).
- `src/core.ts` — shared hook + route bodies, settings loader.
- `src/snippets.ts` — builds the Cloudflare UI snippet fragments.
- `src/admin.ts` — Block Kit admin page (settings + backfill actions).
- `src/services/ai-search-client.ts` — AI Search client (binding + REST).
- `src/services/ai-search-backend.ts` — indexing/search/chat over the client.
- `src/services/backfill.service.ts` — resumable, crash-safe backfill engine.

Plugin storage (declared in the descriptor, provisioned by the host):
`backfill_job` (durable job record) and `doc_state` (per-document content-hash
dedup for backfill).

---

## Honest positioning

This plugin is a thin, opinionated bridge between EmDash content and Cloudflare
AI Search. It does not implement its own retrieval, embeddings, or chat — those
are Cloudflare's managed service, and the model/tuning knobs live there. If you
need something the managed service doesn't expose (custom retrieval, multi-turn
memory beyond what the snippet offers, a bespoke widget), that's out of scope for
this plugin by design.

Known limitations are tracked as issues:
[#2 backfill cron](https://github.com/theweekendprojects/emdash-ai-search/issues/2),
[#3 /ai-chat page](https://github.com/theweekendprojects/emdash-ai-search/issues/3),
[#4 richer styling](https://github.com/theweekendprojects/emdash-ai-search/issues/4).

## License

MIT.
