/**
 * Block Kit admin page (one private `admin` route drives the whole panel).
 *
 * Handles the three EmDash interaction types:
 *   - page_load    → render settings form + backfill controls
 *   - form_submit  → save settings to ctx.kv ("settings:*"), re-render
 *   - block_action → run an operation (backfill / reindex), re-render
 *
 * Declarative only — no browser JS ships from the plugin. Works in both
 * sandboxed and native modes.
 */

import type { Ctx } from "./services/host";
import type { BackendFactory } from "./core";
import { loadSettings, routeIndex, startBackfill, cancelBackfill, backfillStatus } from "./core";
import { normalizeEndpoint } from "./snippets";

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

  // Surface a backend build error (e.g. missing AI_SEARCH binding) if present.
  let backendError: string | null = null;
  try {
    factory.build(ctx, settings);
  } catch (err) {
    backendError = err instanceof Error ? err.message : String(err);
  }

  const endpointOk = !!normalizeEndpoint(settings.publicEndpointUrl);

  const blocks: unknown[] = [
    { type: "header", text: "AI Search" },
    {
      type: "context",
      text: "Powered by Cloudflare AI Search. Content is indexed into your instance's built-in storage on publish (indexed per file, within seconds). Search and chat are served by Cloudflare's UI snippets.",
    },
  ];

  if (backendError) {
    blocks.push({
      type: "banner",
      variant: "error",
      title: "AI Search not ready",
      description: `${backendError}`,
    });
  }

  // ── Connection settings (sensitive: LOCKED by default) ───────────────────────
  // These fields hold the AI Search connection identity — instance name,
  // Cloudflare account id, and API token. They are configured once and rarely
  // change, and browser autofill/password managers love to overwrite them, so
  // we DON'T expose editable inputs by default. Instead we show the current
  // values read-only (token masked) and gate the actual inputs behind an
  // "Edit connection settings" toggle (a client-side conditional field — no
  // round-trip). With the toggle off the inputs aren't rendered at all, so a
  // stray Save can't clobber a good token with an empty/autofilled value.
  const tokenStored = !!settings.cfApiToken;
  blocks.push({
    type: "fields",
    fields: [
      { label: "AI Search instance", value: settings.aiSearchInstance || "— not set —" },
      { label: "Cloudflare Account ID", value: settings.cfAccountId ? maskValue(settings.cfAccountId) : "— not set —" },
      { label: "Cloudflare API Token", value: tokenStored ? "•••••••• (stored)" : "— not set —" },
    ],
  });
  blocks.push({
    type: "context",
    text: "Connection settings are locked to prevent accidental overwrites (e.g. browser autofill). Toggle “Edit connection settings” below to change them.",
  });

  const EDIT = "editConnection"; // conditional-visibility switch action_id

  const fields: unknown[] = [
    // The unlock switch. Default OFF → the sensitive inputs below stay hidden and
    // the stored values are shown read-only above.
    {
      type: "toggle",
      action_id: EDIT,
      label: "Edit connection settings",
      initial_value: false,
    },
    {
      type: "text_input",
      action_id: "aiSearchInstance",
      label: "AI Search instance name",
      initial_value: settings.aiSearchInstance,
      condition: { field: EDIT, eq: true },
    },
    {
      type: "text_input",
      action_id: "cfAccountId",
      label: "Cloudflare Account ID (sandboxed REST mode only)",
      initial_value: settings.cfAccountId,
      condition: { field: EDIT, eq: true },
    },
    {
      type: "secret_input",
      action_id: "cfApiToken",
      label: tokenStored
        ? "Cloudflare API Token (leave blank to keep the stored token)"
        : "Cloudflare API Token (sandboxed REST mode only)",
      condition: { field: EDIT, eq: true },
    },
    // Non-sensitive indexing settings — always editable.
    {
      type: "text_input",
      action_id: "selectedCollections",
      label: 'Indexed collections (JSON array, e.g. ["posts","pages"])',
      initial_value: JSON.stringify(settings.selectedCollections),
    },
    {
      type: "toggle",
      action_id: "indexDrafts",
      label: "Also index drafts (index on every save, not just publish)",
      initial_value: (await ctx.kv.get<boolean>("settings:indexDrafts")) === true,
    },
    {
      type: "toggle",
      action_id: "forceReindex",
      label: "Force reindex (re-upload even unchanged posts)",
      initial_value: (await ctx.kv.get<boolean>("settings:forceReindex")) === true,
    },
    {
      type: "number_input",
      action_id: "resultsLimit",
      label: "Results per query",
      min: 1,
      max: 50,
      initial_value: settings.resultsLimit,
    },
  ];

  // ── Site UI: Cloudflare snippets ────────────────────────────────────────────
  blocks.push({ type: "divider" });
  blocks.push({ type: "header", text: "Site search & chat UI" });
  blocks.push({
    type: "context",
    text:
      "Enable the Public Endpoint on your AI Search instance in the Cloudflare dashboard " +
      "(Settings → Public Endpoint), then paste its URL below. The plugin injects Cloudflare's " +
      "chat bubble / search modal on every public page — no code changes. A full chat page is " +
      "served at /_emdash/api/plugins/ai-search/ai-chat.",
  });
  if (settings.publicEndpointUrl && !endpointOk) {
    blocks.push({
      type: "banner",
      variant: "warning",
      title: "Public endpoint URL not recognized",
      description: "Expected something like https://<id>.search.ai.cloudflare.com/ or a custom domain.",
    });
  }
  // Show the current endpoint read-only; gate its input behind the same edit
  // toggle so it isn't accidentally overwritten either.
  blocks.push({
    type: "fields",
    fields: [{ label: "Public endpoint URL", value: settings.publicEndpointUrl || "— not set —" }],
  });

  fields.push(
    {
      type: "text_input",
      action_id: "publicEndpointUrl",
      label: "Public endpoint URL",
      placeholder: "https://<id>.search.ai.cloudflare.com/",
      initial_value: settings.publicEndpointUrl,
      condition: { field: EDIT, eq: true },
    },
    {
      type: "toggle",
      action_id: "showChatBubble",
      label: "Show floating chat bubble on all pages",
      initial_value: settings.showChatBubble,
    },
    {
      type: "toggle",
      action_id: "showSearchModal",
      label: "Show Cmd/Ctrl+K search modal on all pages",
      initial_value: settings.showSearchModal,
    },
    {
      type: "select",
      action_id: "snippetTheme",
      label: "Snippet theme",
      options: [
        { label: "Auto (follow system)", value: "auto" },
        { label: "Light", value: "light" },
        { label: "Dark", value: "dark" },
      ],
      initial_value: settings.snippetTheme,
    },
    {
      type: "text_input",
      action_id: "snippetAccent",
      label: "Accent color (hex, optional)",
      initial_value: settings.snippetAccent,
    },
  );

  blocks.push({ type: "form", block_id: "settings", fields, submit: { label: "Save settings", action_id: "save_settings" } });

  // ── Backfill (resumable, cron-drained) ──────────────────────────────────────
  blocks.push({ type: "divider" });
  blocks.push({ type: "header", text: "Backfill existing content" });
  blocks.push({
    type: "context",
    text:
      "Installed on a site with existing content? Start a backfill — it uploads your archive to " +
      "AI Search in the background, one batch per minute (resumable, crash-safe, skips unchanged docs). " +
      "New content indexes automatically on publish.",
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
        { label: "Uploaded", value: String(job.processed) },
        { label: "Skipped (unchanged)", value: String(job.skipped) },
        { label: "Removed", value: String(job.removed) },
        { label: "Errors", value: String(job.errors) },
        { label: "Queue remaining", value: String(job.queue.length) },
      ],
    });
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
          { label: "Uploaded", value: String(job.processed) },
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

  // Force-reindex state (set via the "Force reindex" toggle in the settings form
  // above; saved with "Save settings"). When ON, Start backfill and "Reindex now"
  // re-upload EVERY published post, even unchanged ones. When OFF (default),
  // unchanged posts are skipped to save uploads.
  const forceReindex = (await ctx.kv.get<boolean>("settings:forceReindex")) === true;
  blocks.push({
    type: "context",
    text:
      forceReindex
        ? "⚠️ Force reindex is ON (set in settings above): the next backfill / reindex re-uploads every published post, including unchanged ones. Use this to rebuild the index (e.g. after recreating the AI Search instance), then turn it off for normal, cost-saving runs."
        : "Normally, indexing skips posts whose content hasn't changed since they were last indexed (saves uploads). Enable “Force reindex” in the settings above (and Save) to re-upload everything anyway — useful to repair the index if it drifted from what the plugin thinks is indexed.",
  });

  // Immediate single-collection reindex (small, synchronous — quick refresh).
  if (settings.selectedCollections.length > 0) {
    blocks.push({ type: "context", text: "Or reindex one collection now (small collections only — large ones should use backfill):" });
    blocks.push({
      type: "actions",
      elements: settings.selectedCollections.map((c) => ({
        type: "button",
        label: forceReindex ? `Force reindex "${c}" now` : `Reindex "${c}" now`,
        action_id: `reindex:${c}`,
      })),
    });
  }

  blocks.push({ type: "divider" });
  blocks.push({
    type: "context",
    text: "Per-document indexing status lives in the Cloudflare AI Search dashboard (Overview → Indexed Items).",
  });

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
      // The force-reindex flag is a form toggle saved via "Save settings"
      // (settings:forceReindex). Read it here so reindex/backfill honor it.
      const force = (await ctx.kv.get<boolean>("settings:forceReindex")) === true;
      if (actionId === "backfill_start") {
        const r = await startBackfill(ctx, factory, { force });
        return render(ctx, factory, {
          message: `Backfill started for ${r.collections.length} collection(s)${force ? " (force: re-uploading all)" : ""} — draining in the background.`,
          type: "success",
        });
      }
      if (actionId === "backfill_cancel") {
        await cancelBackfill(ctx, factory);
        return render(ctx, factory, { message: "Backfill cancelled.", type: "info" });
      }
      if (actionId.startsWith("reindex:")) {
        const collectionId = actionId.slice("reindex:".length);
        const result = await routeIndex(ctx, factory, { collectionId, force });
        const detail = result && typeof result === "object" && "errorMessage" in result ? ` — ${(result as any).errorMessage}` : "";
        return render(ctx, factory, { message: `Reindexed "${collectionId}"${force ? " (forced)" : ""}${detail}`, type: "success" });
      }
      return render(ctx, factory);
    }

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

  // Connection settings are only writable when the operator explicitly enabled
  // "Edit connection settings". When the toggle is off, the host doesn't render
  // those inputs, so they arrive undefined — but we double-guard here so a
  // client that submits stale/autofilled values while locked can't overwrite
  // the stored connection identity or token.
  const editConnection = v.editConnection === true;
  if (editConnection) {
    await setIf("aiSearchInstance", v.aiSearchInstance);
    await setIf("cfAccountId", v.cfAccountId);
    // Only overwrite the token when the user typed a new one (secret fields come
    // back empty when left untouched — don't clobber a stored token with "").
    if (typeof v.cfApiToken === "string" && v.cfApiToken.length > 0) {
      await ctx.kv.set("settings:cfApiToken", v.cfApiToken);
    }
    await setIf(
      "publicEndpointUrl",
      typeof v.publicEndpointUrl === "string" ? v.publicEndpointUrl.trim() : v.publicEndpointUrl,
    );
  }

  await setIf("resultsLimit", Number(v.resultsLimit ?? 20));
  await ctx.kv.set("settings:selectedCollections", normalizeCollections(v.selectedCollections));
  await ctx.kv.set("settings:indexDrafts", v.indexDrafts === true);
  await ctx.kv.set("settings:forceReindex", v.forceReindex === true);

  // Site UI snippets
  await ctx.kv.set("settings:showChatBubble", v.showChatBubble === true);
  await ctx.kv.set("settings:showSearchModal", v.showSearchModal === true);
  if (v.snippetTheme === "auto" || v.snippetTheme === "light" || v.snippetTheme === "dark") {
    await ctx.kv.set("settings:snippetTheme", v.snippetTheme);
  }
  await setIf("snippetAccent", v.snippetAccent);
}

/** Mask a mostly-sensitive identifier for read-only display (keep a short tail). */
function maskValue(v: string): string {
  const s = String(v);
  if (s.length <= 4) return "••••";
  return `${"•".repeat(Math.max(4, s.length - 4))}${s.slice(-4)}`;
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
