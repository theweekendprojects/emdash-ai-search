/**
 * Shared Block Kit admin page.
 *
 * One private `admin` route drives the whole panel. It handles the three
 * EmDash interaction types:
 *   - page_load    → render settings form + index-status table + stats + actions
 *   - form_submit  → save settings to ctx.kv ("settings:*"), re-render
 *   - block_action → run an operation (sync all / backfill a collection), re-render
 *
 * Declarative only — no browser JS ships from the plugin. Works in both
 * sandboxed and native modes (native supports Block Kit too), so both entries
 * point their `admin` route at handleAdmin().
 *
 * Block/element shapes follow EmDash's block-kit reference.
 */

import type { Ctx } from "./services/host";
import type { BackendFactory } from "./core";
import { loadSettings, routeIndex, startBackfill, cancelBackfill, backfillStatus } from "./core";

type Blocks = { blocks: unknown[]; toast?: { message: string; type: "success" | "error" | "info" } };

interface Interaction {
  type: "page_load" | "block_action" | "form_submit";
  action_id?: string;
  block_id?: string;
  value?: unknown;
  values?: Record<string, unknown>;
}

/** Build the full page from current settings + status. */
async function render(ctx: Ctx, factory: BackendFactory, toast?: Blocks["toast"]): Promise<Blocks> {
  const settings = await loadSettings(ctx);
  const isVectorize = settings.kbBackend === "vectorize";

  // Try to build the backend; on failure show the real reason. Status rows come
  // from the backend (empty for the managed AI Search backend).
  let backendError: string | null = null;
  let statusRows: Array<Record<string, unknown>> = [];
  try {
    const backend = factory.build(ctx, settings);
    statusRows = (await backend.status()).map((r) => ({
      collection: r.collectionName,
      status: r.status + (r.errorMessage ? ` — ${r.errorMessage}` : ""),
      items: r.totalItems,
      chunks: r.indexedChunks,
      lastSync: r.lastSyncAt ? new Date(r.lastSyncAt).toISOString() : "never",
    }));
  } catch (err) {
    backendError = err instanceof Error ? err.message : String(err);
  }

  const blocks: unknown[] = [
    { type: "header", text: "AI Search" },
    {
      type: "context",
      text: `Backend: ${isVectorize ? "Vectorize (self-managed, advanced)" : "Cloudflare AI Search (managed, recommended)"}`,
    },
  ];

  if (backendError) {
    blocks.push({
      type: "banner",
      variant: "error",
      title: "AI search engine not ready",
      description: `${backendError} — check the settings for the selected backend below.`,
    });
  }

  // ── Backend selector + shared settings ──────────────────────────────────────
  const fields: unknown[] = [
    {
      type: "select",
      action_id: "kbBackend",
      label: "Retrieval backend",
      options: [
        { label: "Cloudflare AI Search — managed, easiest (recommended)", value: "ai-search" },
        { label: "Vectorize — self-managed, advanced (custom chunking/models)", value: "vectorize" },
      ],
      initial_value: settings.kbBackend,
    },
    {
      type: "text_input",
      action_id: "cfAccountId",
      label: "Cloudflare Account ID (sandboxed mode only)",
      initial_value: settings.cfAccountId,
    },
    {
      type: "secret_input",
      action_id: "cfApiToken",
      label: "Cloudflare API Token (sandboxed mode only)",
    },
    {
      type: "text_input",
      action_id: "chatModel",
      label: "Chat / generation model",
      initial_value: settings.chatModel,
    },
    {
      type: "number_input",
      action_id: "resultsLimit",
      label: "Results Per Query",
      min: 1,
      max: 50,
      initial_value: settings.resultsLimit,
    },
    {
      type: "number_input",
      action_id: "maxTokens",
      label: "Chat max answer tokens",
      min: 64,
      max: 4096,
      initial_value: settings.maxTokens,
    },
    {
      type: "text_input",
      action_id: "selectedCollections",
      label: 'Indexed Collections (JSON array, e.g. ["blog_posts","docs"])',
      initial_value: JSON.stringify(settings.selectedCollections),
    },
    {
      type: "toggle",
      action_id: "indexDrafts",
      label: "Also index drafts (index on every save, not just publish)",
      initial_value: (await ctx.kv.get<boolean>("settings:indexDrafts")) === true,
    },
  ];

  // AI Search fields — shown with a `condition` so the host hides them when the
  // Vectorize backend is selected (client-side, no round-trip).
  fields.push(
    {
      type: "text_input",
      action_id: "aiSearchInstance",
      label: "AI Search instance name",
      initial_value: settings.aiSearchInstance,
      condition: { field: "kbBackend", eq: "ai-search" },
    },
    {
      type: "text_input",
      action_id: "aiSearchBucket",
      label: "R2 bucket the instance indexes (pages are written here)",
      initial_value: settings.aiSearchBucket,
      condition: { field: "kbBackend", eq: "ai-search" },
    },
  );

  // Vectorize fields — conditional on the Vectorize backend.
  fields.push(
    {
      type: "text_input",
      action_id: "vectorizeIndex",
      label: "Vectorize index name",
      initial_value: settings.vectorizeIndex,
      condition: { field: "kbBackend", eq: "vectorize" },
    },
    {
      type: "text_input",
      action_id: "embeddingModel",
      label: "Embedding model",
      initial_value: settings.embeddingModel,
      condition: { field: "kbBackend", eq: "vectorize" },
    },
    {
      type: "number_input",
      action_id: "vectorTopK",
      label: "Vector TopK",
      min: 10,
      max: 100,
      initial_value: settings.vectorTopK,
      condition: { field: "kbBackend", eq: "vectorize" },
    },
    {
      type: "number_input",
      action_id: "chatTopK",
      label: "Chat context chunks",
      min: 1,
      max: 20,
      initial_value: settings.chatTopK,
      condition: { field: "kbBackend", eq: "vectorize" },
    },
  );

  // ── Security settings ───────────────────────────────────────────────────────
  blocks.push({ type: "divider" });
  blocks.push({ type: "header", text: "Security settings" });
  blocks.push({
    type: "context",
    text:
      "Rate limiting and optional Turnstile verification for public chat endpoints. " +
      "Note: endpoints are public by necessity; these settings cap abuse but don't make them private.",
  });

  fields.push(
    {
      type: "number_input",
      action_id: "chatRateLimitPerMin",
      label: "Chat rate limit: per minute",
      min: 1,
      max: 60,
      initial_value: settings.chatRateLimitPerMin,
    },
    {
      type: "number_input",
      action_id: "chatRateLimitPerDay",
      label: "Chat rate limit: per day",
      min: 10,
      max: 1000,
      initial_value: settings.chatRateLimitPerDay,
    },
    {
      type: "toggle",
      action_id: "enableTurnstile",
      label: "Require Cloudflare Turnstile verification",
      initial_value: (await ctx.kv.get<boolean>("settings:enableTurnstile")) === true,
    },
    {
      type: "text_input",
      action_id: "turnstileSiteKey",
      label: "Turnstile site key (required if enabled)",
      initial_value: settings.turnstileSiteKey,
      condition: { field: "enableTurnstile", eq: true },
    },
  );

  blocks.push({ type: "form", block_id: "settings", fields, submit: { label: "Save settings", action_id: "save_settings" } });

  // ── Backfill (resumable, cron-drained) ──────────────────────────────────────
  blocks.push({ type: "divider" });
  blocks.push({ type: "header", text: "Backfill existing content" });
  blocks.push({
    type: "context",
    text:
      "Installed on a blog with existing posts? Start a backfill — it indexes your " +
      "archive in the background, one batch per minute (resumable, crash-safe, skips " +
      "unchanged posts). New posts index automatically on publish.",
  });

  let job: Awaited<ReturnType<typeof backfillStatus>> = null;
  try {
    job = await backfillStatus(ctx, factory);
  } catch {
    job = null;
  }

  if (job && job.phase === "processing") {
    blocks.push({
      type: "fields",
      fields: [
        { label: "Backfill", value: `running — ${job.currentCollection ?? "…"}` },
        { label: isVectorize ? "Indexed" : "Files queued to AI Search", value: String(job.processed) },
        { label: "Skipped (unchanged)", value: String(job.skipped) },
        { label: "Removed", value: String(job.removed) },
        { label: "Errors", value: String(job.errors) },
        { label: "Queue remaining", value: String(job.queue.length) },
      ],
    });
    if (!isVectorize) {
      blocks.push({
        type: "context",
        text: "AI Search indexes the queued files asynchronously — actual indexing progress is in the Cloudflare dashboard.",
      });
    }
    blocks.push({
      type: "actions",
      elements: [{ type: "button", label: "Cancel backfill", action_id: "backfill_cancel", style: "danger" }],
    });
  } else {
    if (job && (job.phase === "done" || job.phase === "cancelled" || job.phase === "error")) {
      blocks.push({
        type: "fields",
        fields: [
          { label: "Last backfill", value: job.phase },
          { label: isVectorize ? "Indexed" : "Files queued", value: String(job.processed) },
          { label: "Skipped", value: String(job.skipped) },
          { label: "Removed", value: String(job.removed) },
          { label: "Errors", value: String(job.errors) + (job.lastError ? ` — ${job.lastError}` : "") },
        ],
      });
    }
    blocks.push({
      type: "actions",
      elements: [
        { type: "button", label: "Start backfill (selected collections)", action_id: "backfill_start", style: "primary" },
      ],
    });
  }

  // Immediate single-collection reindex (small, synchronous — for a quick refresh).
  if (settings.selectedCollections.length > 0) {
    blocks.push({ type: "context", text: "Or reindex one collection immediately (small collections only — large ones should use backfill):" });
    blocks.push({
      type: "actions",
      elements: settings.selectedCollections.map((c) => ({
        type: "button",
        label: `Reindex "${c}" now`,
        action_id: `reindex:${c}`,
      })),
    });
  }

  // ── Status table (Vectorize only; AI Search status lives in CF dashboard) ────
  if (isVectorize) {
    blocks.push({ type: "divider" });
    blocks.push({ type: "header", text: "Index status" });
    blocks.push({
      type: "table",
      page_action_id: "status_page",
      empty_text: "No collections indexed yet. Add collection ids above, save, then Sync.",
      columns: [
        { key: "collection", label: "Collection" },
        { key: "status", label: "Status" },
        { key: "items", label: "Items" },
        { key: "chunks", label: "Chunks" },
        { key: "lastSync", label: "Last sync" },
      ],
      rows: statusRows,
    });
  } else {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "context",
      text: "Managed backend — per-document indexing progress is shown in the Cloudflare AI Search dashboard, not here.",
    });
  }

  return toast ? { blocks, toast } : { blocks };
}

/** The admin route entry point — call from both plugin entries. */
export async function handleAdmin(ctx: Ctx, factory: BackendFactory, rawInput: unknown): Promise<Blocks> {
  const interaction = (rawInput ?? { type: "page_load" }) as Interaction;

  try {
    if (interaction.type === "form_submit" && interaction.action_id === "save_settings") {
      const v = interaction.values ?? {};
      await saveSettings(ctx, v);
      return render(ctx, factory, { message: "Settings saved", type: "success" });
    }

    if (interaction.type === "block_action") {
      const actionId = interaction.action_id ?? "";
      if (actionId === "backfill_start") {
        const r = await startBackfill(ctx, factory);
        return render(ctx, factory, {
          message: `Backfill started for ${r.collections.length} collection(s) — draining in the background.`,
          type: "success",
        });
      }
      if (actionId === "backfill_cancel") {
        await cancelBackfill(ctx, factory);
        return render(ctx, factory, { message: "Backfill cancelled.", type: "info" });
      }
      if (actionId.startsWith("reindex:")) {
        const collectionId = actionId.slice("reindex:".length);
        await routeIndex(ctx, factory, { collectionId });
        return render(ctx, factory, { message: `Reindexed "${collectionId}"`, type: "success" });
      }
      // status_page (table paging/sort) or unknown → just re-render.
      return render(ctx, factory);
    }

    // page_load (and any fallthrough)
    return render(ctx, factory);
  } catch (err) {
    ctx.log.error("[ai-search] admin action failed", { err: String(err) });
    return render(ctx, factory, {
      message: err instanceof Error ? err.message : "Action failed",
      type: "error",
    });
  }
}

/** Persist submitted form values to the settings:* KV namespace. */
async function saveSettings(ctx: Ctx, v: Record<string, unknown>): Promise<void> {
  const setIf = async (key: string, value: unknown) => {
    if (value !== undefined && value !== null) await ctx.kv.set(`settings:${key}`, value);
  };
  if (v.kbBackend === "vectorize" || v.kbBackend === "ai-search") {
    await ctx.kv.set("settings:kbBackend", v.kbBackend);
  }
  await setIf("cfAccountId", v.cfAccountId);
  // Only overwrite the token when the user typed a new one (secret fields come
  // back empty when left untouched — don't clobber a stored token with "").
  if (typeof v.cfApiToken === "string" && v.cfApiToken.length > 0) {
    await ctx.kv.set("settings:cfApiToken", v.cfApiToken);
  }
  // AI Search
  await setIf("aiSearchInstance", v.aiSearchInstance);
  await setIf("aiSearchBucket", v.aiSearchBucket);
  // Vectorize
  await setIf("vectorizeIndex", v.vectorizeIndex);
  await setIf("embeddingModel", v.embeddingModel);
  await setIf("vectorTopK", Number(v.vectorTopK ?? 50));
  await setIf("chatTopK", Number(v.chatTopK ?? 6));
  // Shared
  await setIf("resultsLimit", Number(v.resultsLimit ?? 20));
  await ctx.kv.set("settings:selectedCollections", normalizeCollections(v.selectedCollections));
  await ctx.kv.set("settings:indexDrafts", v.indexDrafts === true);
  await setIf("chatModel", v.chatModel);
  await setIf("maxTokens", Number(v.maxTokens ?? 512));
  // Security settings
  await setIf("chatRateLimitPerMin", Number(v.chatRateLimitPerMin ?? 15));
  await setIf("chatRateLimitPerDay", Number(v.chatRateLimitPerDay ?? 150));
  await ctx.kv.set("settings:enableTurnstile", v.enableTurnstile === true);
  await setIf("turnstileSiteKey", v.turnstileSiteKey);
}

function normalizeCollections(input: unknown): string {
  if (Array.isArray(input)) return JSON.stringify(input.map(String));
  if (typeof input === "string") {
    const s = input.trim();
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) return JSON.stringify(parsed.map(String));
    } catch {
      // fall through: treat as comma-separated
    }
    if (s.length === 0) return "[]";
    return JSON.stringify(s.split(",").map((x) => x.trim()).filter(Boolean));
  }
  return "[]";
}
