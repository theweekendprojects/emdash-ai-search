# emdash-ai-search

Semantic search + grounded AI chat for [EmDash CMS](https://github.com/emdash-cms/emdash).
Every published post/page is automatically indexed; public `search` and `chat`
routes answer natural-language queries over your own content.

**New in v0.8**: The chat widget is powered by [Deep Chat](https://deepchat.dev),
a framework-agnostic web component. Endpoints are hardened with origin validation,
per-IP rate limiting (configurable), and optional Cloudflare Turnstile verification.
SSE streaming is built-in (falls back to single response if unavailable).

There are **two independent choices**: which **backend** does the retrieval, and
which **runtime mode** the plugin runs in. They're orthogonal.

## Choice 1 — Backend (set in Settings → "Retrieval backend")

| | **Cloudflare AI Search** (default) | **Vectorize** (advanced) |
|---|---|---|
| Who does chunking/embedding/indexing | **Cloudflare (managed)** | **this plugin** (our pipeline) |
| Setup surface | R2 bucket + instance name | embedding model, chunk behaviour, index |
| Search quality | hybrid + reranking, managed | vector-only, self-tuned |
| Generation | built-in (`chat/completions`) | Workers AI text model |
| Best for | **non-technical site owners** (minimal setup) | developers who want control |
| How content is indexed | pages written to an R2 bucket AI Search crawls | chunk→embed→Vectorize on publish |

**AI Search is the default** — it's the least to configure and hardest to
misconfigure (point it at an R2 bucket and you're done; Cloudflare handles the
rest). Switch to **Vectorize** only if you want to hand-tune chunking/models or
need control the managed service doesn't expose. Both are selected by the
`kbBackend` setting; the plugin is built so switching is a settings change, not a
reinstall.

> AI Search is a Cloudflare **open-beta** service. It's
> generous on the free tier but pricing/limits and API can still shift — pin to
> documented endpoints and watch Cloudflare's release notes. Workers AI /
> inference compute is billed separately from AI Search itself.

## Choice 2 — Runtime mode (how the plugin reaches Cloudflare)

| | **Mode A — Sandboxed + REST** | **Mode B — Native + bindings** |
|---|---|---|
| Reaches Cloudflare via | **REST APIs** over `ctx.http` | Cloudflare **bindings** |
| Config effort | CF account id **+ API token** in Settings | **No token** — bindings in wrangler config |
| Registry-installable | ✅ yes | ❌ no (trusted/local only) |
| Extra requirements | any EmDash | Astro 6 + `@astrojs/cloudflare` v13+ |
| Entry point | `emdash-ai-search/sandbox` | `emdash-ai-search` (default) / `emdash-ai-search/native` |

Both modes support both backends. Sandboxed uses the AI Search / Vectorize /
Workers AI / R2 **REST** APIs; native uses the `ai_search_namespaces`,
`vectorize`, `ai`, and R2 **bindings**. Pick sandboxed for registry
distribution, native for the tokenless experience.

---

## Auto-ingestion: how content gets vectorized

You do **not** trigger indexing manually for new content. The plugin registers
content-lifecycle hooks that fire automatically:

| Event | What happens |
|---|---|
| `content:afterPublish` | The page is chunked, embedded, and upserted to Vectorize |
| `content:afterUnpublish` | Its vectors are deleted |
| `content:afterDelete` | Its vectors are deleted |
| `content:afterSave` | **Only if “Also index drafts” is ON** — indexes on every save |

So: **publish a post → it's searchable within a few seconds** (Vectorize writes
are async). For content that **already existed** when you installed the plugin
(an existing blog), use the **Backfill** feature — see "Backfilling an existing
blog" below. It's resumable and works at any size.

By default only **published** content is indexed. Turn on **Settings → “Also
index drafts”** to index on every save regardless of status (uses
`content:afterSave`). Leave it off for a clean public search index.

---

## Chat widget: Deep Chat

The public chat widget is powered by [Deep Chat](https://deepchat.dev), a
framework-agnostic web component. It provides a polished UI with built-in
streaming support, theming, and accessibility. The widget is injected as a
Portable Text block (native mode only) and calls `/_emdash/api/plugins/ai-search/chat`
or `/chat/stream` with `{ question, filters }`. Answers include grounded sources
with citation links. Rate limits and origin validation are enforced on the
server; the widget gracefully surfaces 429/403 errors to users.

---

## Backfilling an existing blog

Installing on a blog that **already has posts**? New posts index automatically on
publish, but the existing archive needs a one-time backfill. Open **Admin →
Plugins → AI Search → Backfill** and click **Start backfill**. That's it — it
runs in the background and you can watch progress (indexed / skipped / remaining).

### How it works (architecture)

Indexing an entire archive can't run in one request — a large blog would exceed
the Worker's CPU/wall-time limits. So backfill is a **durable job drained in
bounded batches by cron**:

```
Start → seed a durable job (queue = your collections) in plugin storage
cron (every minute) → claim a LEASE (compare-and-set) so only one worker runs
                    → index ONE bounded batch (25 docs) via the backend
                    → advance the content cursor, release the lease, persist
                    → repeat next tick until the queue drains → done
```

Properties this buys you:

- **Any size.** Bounded work per tick means a 50-post blog and a 50,000-post blog
  both just work; the big one simply takes more ticks.
- **Crash-safe & resumable.** State (cursor, counters, phase) lives in storage,
  not memory. If a batch dies mid-way, the lease expires and the next tick
  resumes from the persisted cursor. Each document index is **idempotent**
  (purge-then-upsert), so re-processing a batch is harmless.
- **Cheap to re-run (dedup).** A content hash per document is stored; unchanged
  posts are **skipped** on re-runs, so you can safely re-backfill (e.g. after a
  settings change) without paying to re-embed everything.
- **Single-worker safety.** A compare-and-set lease prevents two overlapping cron
  ticks from double-processing.
- **Self-healing removals.** A post that's no longer published is purged from the
  index during backfill.

### Notes

- Backfill drains the collections in **Indexed Collections**. Set those first.
- **Cron availability (known limitation):** the background drainer relies on the
  `cron` hook, which the host only dispatches for a task registered via
  `ctx.cron.schedule()`. In some native deployments `ctx.cron` is unavailable at
  activation time, so no task is registered and a **Start backfill** job can stay
  at "processing" without advancing. Bulk backfill is therefore best-effort right
  now. This does **not** affect new content: publishing indexes immediately via
  `content:afterPublish` (no cron involved). For existing archives, the
  per-collection **“Reindex now”** button runs synchronously and works for small
  collections regardless of cron. A cron-independent bulk reindex is a planned
  follow-up.
- Batch size (25) and cadence (1/min) are conservative defaults in
  `backfill-types.ts` — raise them for faster backfill on capable runtimes.

---

## Security

Public chat endpoints are hardened with multiple layers:

0. **EmDash core CSRF (built-in)** — Before the plugin runs, EmDash core rejects
   cross-origin requests to public plugin routes with a `CSRF_REJECTED` **403**.
   This is the primary origin protection; it applies to `search` and `chat` alike.
1. **Origin/Referer validation (defence in depth)** — The plugin re-checks the
   Origin/Referer against your site origin. It *fails open* when that metadata is
   absent (so it never blocks the same-origin traffic core already vetted). A
   mismatch returns a JSON `{ error, code: "FORBIDDEN_ORIGIN" }` (the route still
   responds `200` — plugin routes cannot set their own HTTP status; the widget
   surfaces the message).
2. **Per-IP rate limiting** — Configurable limits (default 15/min, 150/day) via
   plugin storage. When exceeded, returns `{ error, code: "RATE_LIMITED" }`.
3. **Optional Turnstile verification** — Enable in Settings to require Cloudflare
   Turnstile before processing chat requests. **Off by default and not yet
   verified end-to-end**; note that Cloudflare's siteverify needs the Turnstile
   *secret* key (the current field is labelled "site key" — treat as experimental).

Configure these in **Admin → AI Search → Security settings**. Note: endpoints
are public by necessity (chat widgets need to be callable from any page); these
settings cap abuse but don't make them private. Streaming answers (`chat/stream`)
currently omit the **Sources:** citation line — the streaming backend contract
yields answer text only; the non-streaming fallback includes citations.

## Endpoints: search and chat

Two public routes sit on top of the vector index:

**Search** — ranked matching chunks, no LLM:

```
POST /_emdash/api/plugins/ai-search/search
{ "query": "how do refunds work", "limit": 10, "filters": { "collections": ["docs"] } }
```

**Chat (the chatbot)** — retrieve-then-generate a grounded answer with citations:

```
POST /_emdash/api/plugins/ai-search/chat
{ "question": "how do refunds work?", "filters": { "collections": ["docs"] } }
```

```json
{
  "answer": "Refunds are issued within 14 days …",
  "citations": [
    { "contentId": "…", "title": "Refund policy", "collectionId": "docs", "score": 0.82 }
  ],
  "usedChunks": 6
}
```

### How the chatbot works

Search returns matching chunks; **chat** adds the generation step — the "G" in
retrieve-then-generate that SonicJS's ai-search never had. Entirely inside the plugin:

```
question → embed → Vectorize query (top chatTopK chunks, FULL chunk text)
        → prompt: system("answer ONLY from context") + context + question
        → Cloudflare Workers AI text model
             native  → env.AI.run(model, { messages })        (tokenless)
             sandboxed → Workers AI REST /ai/run/{model}        (uses token)
        → { answer, citations, usedChunks }
```

- **Model** — set **Chat Model** in the admin panel. Default
  `@cf/meta/llama-3.1-8b-instruct`; swap in any Workers AI text model (e.g.
  `@cf/meta/llama-3.3-70b-instruct-fp8-fast` for higher quality).
- **Grounding** — the system prompt forces answers to come only from retrieved
  context and to admit uncertainty (anti-hallucination). To make that real, the
  plugin stores the chunk text in vector metadata (`chunk_text`), not just the
  500-char display snippet. It's capped at ~6000 chars to stay under Vectorize's
  10 KiB per-vector metadata limit (a very large chunk is truncated for
  grounding but still fully searchable).
- **Citations** — deduped source documents, best score first, for linking back.
- **Settings** (admin panel) — Chat Model, Chat context chunks (`chatTopK`,
  default 6), Chat max answer tokens (`maxTokens`, default 512).
- **Streaming (native only)** — a `chat/stream` route returns Server-Sent Events
  for token-by-token output. This is **native-mode only**: EmDash **sandboxed**
  routes cannot return a raw streaming `Response` (the sandbox bridge wraps route
  results in a JSON envelope — confirmed in the API-routes docs), so the
  sandboxed build keeps the single-response `chat` route. The chat widget tries
  `chat/stream` first and **falls back** to `chat` automatically, so it streams
  on native and still works on sandboxed. Both backends stream upstream (AI
  Search `chat/completions` and Workers AI both support `stream: true`).

  ```
  POST /_emdash/api/plugins/ai-search/chat/stream   (native build only)
  { "question": "…" }
  → SSE: data: {"delta":"Refunds "}  data: {"delta":"are "} … data: [DONE]
  ```

> **Re-index note:** `chunk_text` grounding was added in this version. Content
> indexed earlier only has the snippet in metadata; chat falls back to it, but
> run **Sync all** once to re-index with full chunk text for best answers.

### Drop the chatbot on a page (front-end widget)

You don't have to write any fetch code. The plugin ships a self-contained chat
widget powered by [Deep Chat](https://deepchat.dev), a framework-agnostic web
component that renders a floating button + panel or inline panel. It calls the
`chat` or `chat/stream` route automatically.

> **Native build only.** Per EmDash, Portable Text blocks + their Astro render
> components are a **native-plugin** feature — sandboxed/registry builds can't
> ship them. So the injectable widget requires **Mode B (native)**. (In sandboxed
> mode you can still call the `chat` route from your own markup.)

**Option 1 — from the editor (no code).** In any Portable Text field, type `/`
and pick **“AI Chat”**. A small form lets you set the panel title, placeholder,
welcome message, optional collection scope, accent color, floating/inline
mode, and whether to show rate limit errors. Publish the page → the widget
renders. EmDash auto-wires the render component (via the descriptor's
`componentsEntry`); the site author imports nothing.

**Option 2 — directly in an Astro template.**

```astro
---
import { ChatWidget } from "emdash-ai-search/astro";
---

<!-- floating button, scoped to the "docs" collection -->
<ChatWidget node={{ title: "Docs assistant", collections: ["docs"], mode: "floating" }} />

<!-- or inline in the page flow -->
<ChatWidget node={{ mode: "inline", accent: "#0b7" }} />
```

The widget uses Deep Chat (MIT), supports multiple instances per page, renders
answers with a **Sources:** line from the citations, and handles streaming with
automatic fallback to single-response if SSE is unavailable.

### Security settings

Configure the public chat endpoint's security in **Admin → AI Search → Security
settings**:

| Setting | Description | Default |
|---|---|---|
| Chat rate limit: per minute | Max requests per minute per IP | 15 |
| Chat rate limit: per day | Max requests per day per IP | 150 |
| Require Turnstile | Enable Cloudflare Turnstile verification | off |
| Turnstile site key | Your Turnstile site key (if enabled) | — |

When rate limited (429) or access denied (403), the widget shows a user-friendly
message. Enable Turnstile for additional spam protection.

### Streaming

The widget tries `chat/stream` (SSE) first; if unavailable (sandboxed build or
network issue), it falls back to the single-response `chat` route. Both backends
(streaming or non-streaming) return full answers with citations. Streaming
requires **native mode** (sandboxed routes can't return raw `Response` streams).

---

## Setup — AI Search backend (default, recommended)

The managed path. Minimal steps:

1. **Create an R2 bucket** for the plugin to write pages into, e.g.
   `emdash-ai-search-content`.
2. **Create an AI Search instance** in the Cloudflare dashboard (Compute & AI →
   AI Search), pointed at that R2 bucket. Note the instance name.
3. **Settings → Retrieval backend = "Cloudflare AI Search"**, then set the
   instance name + bucket. Sandboxed mode also needs a CF account id + an API
   token with **AI Search:Edit + AI Search:Run** (and R2 write). Native mode
   needs the `ai_search_namespaces` + R2 bucket bindings in wrangler config
   instead — no token.

That's it. On publish, the plugin writes each page as a markdown file to the R2
bucket; AI Search indexes it on its own schedule. `search`/`chat` query the
instance directly. Per-document indexing progress is shown in the **Cloudflare
dashboard**, not the plugin admin.

Native `wrangler.jsonc` bindings for this backend:

```jsonc
{
  "ai_search_namespaces": [{ "binding": "AI_SEARCH", "namespace": "default" }],
  "r2_buckets": [{ "binding": "R2", "bucket_name": "emdash-ai-search-content" }]
}
```

---

## Setup — Vectorize backend (advanced)

### 1. Create the Vectorize index

Dimensions must match the embedding model. Default model
`@cf/baai/bge-base-en-v1.5` = **768 dims**, cosine distance:

```sh
npx wrangler vectorize create emdash-ai-search --dimensions=768 --metric=cosine
```

If you change the embedding model, recreate the index with that model's
dimension count.

### 2. Settings — from the admin panel

Everything is configured in the admin panel. Open **EmDash Admin → Plugins →
AI Search**. The plugin ships a full **Block Kit admin page** (declarative — no
browser JS from the plugin) with three parts:

1. **Stats** — collections indexed + total chunks.
2. **Settings form** — all settings, saved with one button:

   | Setting | Mode A (sandboxed) | Mode B (native) |
   |---|---|---|
   | Cloudflare Account ID | **required** | leave blank (unused) |
   | Cloudflare API Token | **required** (Workers AI + Vectorize) | leave blank (unused) |
   | Vectorize Index Name | `emdash-ai-search` | `emdash-ai-search` (informational; binding is authoritative) |
   | Embedding Model | `@cf/baai/bge-base-en-v1.5` | same |
   | Vector TopK | `50` | `50` (capped to 50 by the binding when returning metadata) |
   | Results Per Query | `20` | `20` |
   | Indexed Collections | JSON array, e.g. `["blog_posts","docs"]` (comma-separated also accepted) | same |
   | Also index drafts | off | off |

3. **Backfill** — a **Start backfill** button (with live progress) for indexing
   an existing archive, plus per-collection **“Reindex now”** for a quick
   small-collection refresh. New content never needs these — it indexes
   automatically on publish.
4. **Index status table** — per collection: status, item/chunk counts, last sync.

The panel is the same in both modes (native supports Block Kit too). Saving the
form writes to the plugin's `settings:*` KV, which is what the engine reads.

> **How settings are stored.** The form writes to plugin KV. The API-token field
> is a masked `secret_input`, and leaving it blank on save keeps the existing
> token (it won't be wiped). Per EmDash docs the settings store is **not**
> encrypted at rest — Mode B avoids storing a token at all, which is its main
> advantage.
>
> A basic fallback settings form is also generated from `settingsSchema` in the
> manifest; it writes the same KV keys. The Block Kit page is the richer primary
> UI (it adds status + actions).

---

## Mode A — Sandboxed + REST (registry-installable)

The engine calls the **Cloudflare Workers AI REST API** and **Vectorize v2 REST
API** over `ctx.http.fetch`. That needs the `network:request` capability with
`api.cloudflare.com` allowed — already declared in `emdash-plugin.jsonc`.

### A1. Build

```sh
pnpm install
pnpm run build          # emdash-plugin build → dist/ (descriptor + manifest + bundle)
```

### A2. Register (sandboxed)

`astro.config.mjs`:

```js
import emdash from "emdash/astro";
import aiSearch from "emdash-ai-search/sandbox";

export default defineConfig({
  integrations: [
    emdash({
      sandboxed: [aiSearch],
      sandboxRunner: "@emdash-cms/sandbox-workerd/sandbox",
    }),
  ],
});
```

### A3. Create a Cloudflare API token

Dashboard → **My Profile → API Tokens → Create Token**, with permissions:
- **Workers AI** → Read (Run)
- **Vectorize** → Edit

Paste it into **Settings → Cloudflare API Token**, and your account id into
**Cloudflare Account ID**.

### A4. Done

Publish a post → it's indexed via REST. Query:

```
POST /_emdash/api/plugins/ai-search/search
{ "query": "how do refunds work", "limit": 10, "filters": { "collections": ["docs"] } }
```

---

## Mode B — Native + bindings (tokenless, like the Cloudflare Email plugin)

The engine calls `env.AI.run(...)` and `env.VECTORIZE.query/upsert/deleteByIds(...)`
directly. Auth is the binding — **no API token anywhere**. This is exactly how
`emdash-plugin-cloudflare-email` uses the `send_email` binding.

### B1. Requirements

- EmDash on a **Cloudflare Workers** deployment.
- **Astro 6 + `@astrojs/cloudflare` v13+** (needed for `import { env } from
  "cloudflare:workers"`).
- Native plugins are **trusted/local only** — installed via `plugins: []`, not
  the registry.

### B2. Add the bindings to your site's wrangler config

`wrangler.jsonc` (or `wrangler.toml` equivalent):

```jsonc
{
  "ai": { "binding": "AI" },
  "vectorize": [
    { "binding": "VECTORIZE", "index_name": "emdash-ai-search" }
  ]
}
```

The binding **names must be `AI` and `VECTORIZE`** (what the plugin reads from
`cloudflare:workers`). Run `wrangler types` after editing bindings if you use
generated types.

### B3. Build the native bundle

```sh
pnpm install
pnpm run build:native   # tsc → dist/native.js (+ the shared modules)
```

### B4. Register (trusted / native)

`astro.config.mjs` — note `plugins`, **not** `sandboxed`:

```js
import emdash from "emdash/astro";
import aiSearch from "emdash-ai-search";   // default export = native entry

export default defineConfig({
  integrations: [
    emdash({
      plugins: [aiSearch()],          // native plugins are called as factories
    }),
  ],
});
```

### B5. Done — no token

Leave Account ID / API Token **blank** in Settings; they're unused in this mode.
Publish a post → it's indexed through the bindings. Same `search` route as Mode A.

> **What “zero config” really means:** like the email plugin, Mode B needs no
> API token, but two one-time steps remain irreducible: adding the `AI` +
> `VECTORIZE` bindings to your wrangler config, and creating the Vectorize index
> once. There is no way to skip those — Cloudflare has to know which index the
> Worker may use.

---

## How EmDash plugin modes actually work (the important background)

Verified against the EmDash docs
([SKILL.md](https://github.com/emdash-cms/emdash/blob/main/skills/creating-plugins/SKILL.md),
[hooks](https://github.com/emdash-cms/emdash/blob/main/skills/creating-plugins/references/hooks.md),
[storage](https://github.com/emdash-cms/emdash/blob/main/skills/creating-plugins/references/storage.md))
and the [Cloudflare Email plugin](https://github.com/velvee-ai/emdash-plugin-cloudflare-email).
_Content rephrased for compliance with licensing restrictions._

- **Sandboxed plugins** run in an isolated V8 isolate behind a host bridge. They
  get `ctx.content / storage / kv / http / media / …` and **no raw Cloudflare
  bindings**. That's why Mode A must use the REST APIs over `ctx.http`.
- **Native (trusted) plugins** run in the **host Worker isolate** with the site's
  authority. They can `import { env } from "cloudflare:workers"` and read any
  binding in the site's wrangler config — which is how Mode B gets `AI` and
  `VECTORIZE` with no token. The tradeoff: native plugins are local-only and not
  registry-installable.
- **Access is declared in `emdash-plugin.jsonc`** (capabilities, allowedHosts,
  storage), not in code. Hooks are `(event, ctx)`; routes are `(routeCtx, ctx)`.

---

## Architecture (shared engine, swappable transport)

```
content:afterPublish / afterSave / manual index
        │
        ▼
   SearchService  ── depends only on ports ──▶  Embedder        VectorBackend
   IndexManager                               ├ RestEmbedder  ├ RestVectorBackend   (Mode A, ctx.http)
        │                                      └ BindingEmbedder└ BindingVectorBackend (Mode B, env.*)
        ├─ ChunkingService   (pure)
        ├─ ctx.content.list/get   (source content, content:read)
        └─ ctx.storage.{index_meta, chunk_map}   (state; no capability needed)
```

Files:
- `src/core.ts` — shared hook/route bodies + settings loader (used by both entries)
- `src/admin.ts` — shared Block Kit admin page (settings form + status table + actions)
- `src/transports.ts` — `RestTransportFactory` (Mode A), `BindingTransportFactory` (Mode B)
- `src/plugin.ts` — **sandboxed** entry (`SandboxedPlugin` default export)
- `src/native.ts` — **native** entry (`definePlugin` + `cloudflare:workers` env)
- `src/services/ports.ts` — `Embedder` / `VectorBackend` / `Generator` interfaces
- `src/services/{embedding,vector-store,generator}.{rest,binding}.ts` — the six transports
- `src/services/search.service.ts` (index + retrieve), `chat.service.ts` (grounded AI chat),
  `indexer.ts`, `chunking.service.ts` — engine
- `src/index.ts` — native descriptor factory `aiSearch()` (sets `componentsEntry`)
- `src/astro/ChatWidget.astro` — the injectable front-end widget
- `src/astro/index.ts` — `blockComponents` map (auto-wired into `<PortableText>`)

## Data model (plugin storage — no SQL, no CREATE TABLE)

Declared in `emdash-plugin.jsonc`, provisioned by the host:
- `index_meta` — one record per collection: indexing status + counts.
- `chunk_map` — `contentId → chunkIds[]`, so deletes/re-index purge exactly the
  right vectors (fixes the SonicJS no-op delete).

## Honest positioning

Semantic **search** plus a retrieve-then-generate **chat** endpoint — single-turn,
grounded AI search over your content. Word-count chunking, 768-dim embeddings,
**vector-only** retrieval (no keyword/BM25 or graph retrieval). Retained SonicJS
limitation, documented with a `ponytail:` note in the code: filtering happens
app-side after a `vectorTopK` query (Vectorize metadata filters were unreliable)
— raise `vectorTopK` or move to server-side filters. The chat is single-turn (no
conversation memory) and non-streaming. If you need hybrid vector+keyword,
graph retrieval, multi-turn memory, or larger context windows, either extend this plugin
or point a thin proxy plugin at a purpose-built backend (e.g. Compass). Streaming
now exists but is native-only (sandboxed routes can't return a raw stream).

## Troubleshooting

| Symptom | Mode | Fix |
|---|---|---|
| “network:request capability missing” | A | Plugin isn't sandboxed with `network:request`; check `emdash-plugin.jsonc` + registration |
| “account id / API token not set” | A | Fill both in Settings; token needs Workers AI + Vectorize perms |
| “AI binding missing” / “VECTORIZE binding missing” | B | Add `ai` + `vectorize` bindings (names `AI`, `VECTORIZE`) to wrangler config; redeploy |
| `cloudflare:workers` import fails to build | B | Upgrade to Astro 6 + `@astrojs/cloudflare` v13+ |
| Existing posts not indexed after install | both | Set **Indexed Collections**, then **Start backfill** (Admin → Backfill) |
| Backfill stuck at "processing", not advancing | both | Cron isn't firing — check the runner's scheduled dispatch; small collections can use "Reindex now" instead |
| Search returns nothing right after publish | both | Vectorize writes are async — wait a few seconds |
| Deleted page still appears in results | both | Vectorize deletes are async too; also confirm `chunk_map` had the doc |
| Chat answers "I don't have that information" | both | Content not indexed for that topic, or `chatTopK` too low; check Indexed Collections + run Sync |
| Chat answers seem to ignore the content | both | Content indexed before `chunk_text` existed — run **Sync all** to re-index with full chunk text |
| Chat errors on generation | both | Chat Model isn't a valid Workers AI text model, or (sandboxed) the token lacks Workers AI Run |

## License

MIT. Ported from `lane711/sonicjs` (`ai-search-plugin`), MIT. Built against the
`emdash-cms/emdash` plugin API docs (MIT). Native-binding pattern follows
`velvee-ai/emdash-plugin-cloudflare-email` (MIT).

## Appendix: version history

- **v0.1** — broken first draft: assumed sandboxed plugins get raw AI/Vectorize/D1
  bindings. They don't. (See git history / earlier notes.)
- **v0.2** — corrected to a real **sandboxed** plugin using REST over `ctx.http`,
  `ctx.content`, and `ctx.storage`.
- **v0.3** — added the **native** binding-backed mode (tokenless), sharing the
  engine with v0.2 behind `Embedder`/`VectorBackend` ports; added optional draft
  indexing (`content:afterSave`).
- **v0.3 (admin)** — added a full **Block Kit admin panel** (`src/admin.ts`):
  settings form + index-status table + stats + backfill actions, shared by both
  entries via the `admin` route.
- **v0.4 (chatbot)** — added retrieve-then-generate **chat** (`Generator` port +
  REST/binding impls + `chat.service.ts` + public `chat` route). Stores full
  `chunk_text` in vector metadata for grounding; chat settings (model, topK,
  maxTokens) in the admin panel.
- **v0.4.1 (hardening)** — review-driven fixes: (a) cap `chunk_text` metadata
  under Vectorize's 10 KiB limit so large chunks no longer fail a whole upsert
  batch; (b) `indexCollection`/sync now purge each doc's old vectors before
  re-upsert (was only done on single-doc reindex), so re-syncing a shortened doc
  leaves no orphan vectors; (c) the chunk-id map is written only after a
  successful upsert, so it never claims vectors that failed to land; (d) empty
  documents are purged and skipped instead of embedding an empty batch; (e) chat
  retrieval over-fetches (≥ 4×topK) to survive post-query filtering; (f) admin
  "not ready" banner now reports the real transport build error.
- **v0.7.1 (backfill hardening)** — review-driven fixes: content-hash now covers
  the chunker's full extraction surface incl. nested/array bodies (so edits to
  Portable-Text content aren't wrongly skipped); progress + lease are persisted
  **per-document via compare-and-set** (crash-consistent counters, no re-count on
  resume, lease renewed each doc so a slow batch can't be double-claimed);
  `start()` won't clobber a running job; `cancel()` and all batch writes are
  CAS-guarded so a cancel can't be silently overwritten; backfill lists all
  statuses so unpublished docs are actually purged; AI Search progress is
  labelled "files queued" (indexing is async on Cloudflare).
- **v0.8 (Deep Chat, security, streaming)** — replaced the vanilla chat widget
  with [Deep Chat](https://deepchat.dev), added streaming (SSE with fallback),
  and hardened public endpoints with origin validation, per-IP rate limiting,
  and optional Turnstile verification.
- **v0.7 (resumable backfill)** — replaced the one-shot "Sync all" with a durable,
  **cron-drained, crash-safe, resumable backfill** for indexing existing archives
  of any size. Bounded batches per cron tick; compare-and-set lease for
  single-worker safety; content-hash dedup skips unchanged posts. New files:
  `backfill-types.ts` (pure model + decisions, unit-checked) and
  `backfill.service.ts` (the engine). Admin shows Start/Cancel + live progress.
- **v0.6 (streaming)** — added **SSE streaming chat** (`Generator.generateStream`
  + `AiSearchClient.chatStream` + `SearchBackend.chatStream`), a **native-only**
  `chat/stream` route returning an SSE `Response`, and a shared SSE parser
  (`sse.ts`). The widget consumes the stream token-by-token and falls back to the
  single-response `chat` route. Sandboxed stays single-response (route bridge
  can't stream). No React "assistant UI" library — incompatible with the
  sandboxed widget, and unnecessary for streaming.
- **v0.5 (AI Search backend)** — added a pluggable **SearchBackend** seam and made
  **Cloudflare AI Search (managed) the default backend** over the self-managed
  Vectorize pipeline. Backend chosen by the `kbBackend` setting; both work in
  sandboxed (REST) and native (bindings) modes. AI Search indexes pages written
  to an R2 bucket; Vectorize keeps the original chunk→embed pipeline. New files:
  `search-backend.ts` (interface), `ai-search-backend.ts` + `vectorize-backend.ts`
  (impls), `ai-search-client.ts`, `r2-writer.ts`, `backends.ts` (factories,
  replacing `transports.ts`).
- **v0.4 (widget)** — added a front-end-injectable **chat widget** (native only):
  an "AI Chat" Portable Text block + a dependency-free `ChatWidget.astro` render
  component (auto-wired via `componentsEntry`), plus a `emdash-ai-search/astro` export
  for direct template use.
