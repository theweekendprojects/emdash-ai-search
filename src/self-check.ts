/**
 * Runnable self-check for the binding-free pure logic (backfill decisions +
 * content-hash extraction).
 *
 * No test framework — just asserts. Run with: npx tsx src/self-check.ts
 * Everything else needs the live EmDash ctx (content/storage) or the Cloudflare
 * AI Search binding and is exercised via @emdash-cms/plugin-test / live smoke tests.
 */
import assert from "node:assert";
import {
  newJob,
  decideDoc,
  contentHash,
  isLeaseFree,
  isActive,
  extractIndexableText,
} from "./services/backfill-types";

// ── extractIndexableText: skips urls/short strings, keeps prose, walks nested ──
{
  const text = extractIndexableText({
    url: "https://example.com/ignored",
    tiny: "hi",
    body: "This is a genuine paragraph of content that should be indexed.",
  });
  assert.ok(!text.includes("example.com"), "urls must be skipped");
  assert.ok(!/\bhi\b/.test(text), "sub-10-char strings must be skipped");
  assert.ok(text.includes("genuine paragraph"), "real prose must be kept");

  const nested = extractIndexableText({ blocks: [{ children: [{ text: "nested paragraph of content" }] }] });
  assert.ok(nested.includes("nested paragraph of content"), "must walk nested/array content");
}

// ── Backfill decision logic (pure) ───────────────────────────────────────────

// newJob: queue seeded, phase processing when there's work.
{
  const j = newJob(["blog", "docs"], 1000);
  assert.equal(j.phase, "processing");
  assert.equal(j.currentCollection, "blog");
  assert.deepEqual(j.queue, ["blog", "docs"]);
  assert.equal(j.cursor, null);
}
// newJob with no collections → done immediately.
{
  const j = newJob([], 1000);
  assert.equal(j.phase, "done");
  assert.equal(j.currentCollection, null);
}
// decideDoc: unpublished → remove; unchanged hash → skip; changed/new → index.
{
  assert.equal(decideDoc("abc", "abc", true), "skip");
  assert.equal(decideDoc("abc", "xyz", true), "index");
  assert.equal(decideDoc(undefined, "xyz", true), "index");
  assert.equal(decideDoc("abc", "abc", false), "remove"); // unpublished wins even if hash matches
}
// contentHash: deterministic + sensitive to indexed content, incl. NESTED/ARRAY.
{
  const a = contentHash("Title", { body: "hello there" });
  const b = contentHash("Title", { body: "hello there", id: "ignored", url: "http://skip" });
  const c = contentHash("Title", { body: "changed content here" });
  assert.equal(a, b, "hash ignores skipped keys (id/url)");
  assert.notEqual(a, c, "hash changes when body changes");
  assert.match(a, /^[0-9a-f]{8}$/, "hash is 8 hex chars");

  const nested1 = contentHash("T", { blocks: [{ children: [{ text: "first paragraph of content" }] }] });
  const nested2 = contentHash("T", { blocks: [{ children: [{ text: "EDITED paragraph of content" }] }] });
  assert.notEqual(nested1, nested2, "hash must detect edits in nested/array content");
}
// lease: free when leaseUntil <= now.
{
  const j = { ...newJob(["x"], 0), leaseUntil: 5000 };
  assert.equal(isLeaseFree(j, 4000), false, "leased in the future");
  assert.equal(isLeaseFree(j, 6000), true, "lease expired");
  assert.equal(isActive(j), true);
}

console.log("emdash-ai-search self-check: all assertions passed ✅");
