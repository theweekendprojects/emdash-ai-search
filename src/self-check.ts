/**
 * Runnable self-check for the binding-free logic (ChunkingService).
 *
 * No test framework — just asserts. Run with: npx tsx src/self-check.ts
 * These fail loudly if the chunking/extraction logic breaks, which is the one
 * piece of non-trivial pure logic in the plugin (everything else needs the live
 * EmDash ctx — content/storage/http — and is exercised via @emdash-cms/plugin-test).
 */
import assert from "node:assert";
import { ChunkingService } from "./services/chunking.service";

const c = new ChunkingService();

// 1. Short content → a single chunk.
{
  const chunks = c.chunkContent("d1", "docs", "Title", { body: "a short body of text" });
  assert.equal(chunks.length, 1, "short content should yield exactly one chunk");
  assert.equal(chunks[0]!.id, "d1_chunk_0", "chunk id should be deterministic");
  assert.ok(chunks[0]!.text.includes("short body"), "chunk should contain body text");
}

// 2. extractText skips urls and very short strings, keeps real prose.
{
  const chunks = c.chunkContent("d2", "docs", "T", {
    url: "https://example.com/ignored",
    tiny: "hi",
    body: "This is a genuine paragraph of content that should be indexed.",
  });
  const text = chunks[0]!.text;
  assert.ok(!text.includes("example.com"), "urls must be skipped");
  assert.ok(!text.includes("hi\n"), "sub-10-char strings must be skipped");
  assert.ok(text.includes("genuine paragraph"), "real prose must be kept");
}

// 3. Long content → multiple overlapping chunks with sequential ids.
{
  const longBody = Array.from({ length: 1300 }, (_, i) => `word${i}`).join(" ");
  const chunks = c.chunkContent("d3", "docs", "T", { body: longBody });
  assert.ok(chunks.length >= 3, `expected multiple chunks, got ${chunks.length}`);
  chunks.forEach((ch, i) => assert.equal(ch.chunk_index, i, "chunk_index must be sequential"));
  // overlap: last 50 words of chunk 0 should reappear at the start of chunk 1
  const w0 = chunks[0]!.text.split(" ");
  const w1 = chunks[1]!.text.split(" ");
  assert.equal(w0[w0.length - 50], w1[0], "chunks must overlap by CHUNK_OVERLAP words");
}

// 4. Per-type chunk size is actually applied (regression: it was dead in SonicJS).
{
  const body = Array.from({ length: 500 }, (_, i) => `w${i}`).join(" ");
  // comments cap at 200 words → 500 words must split; default 500 → single chunk.
  const asComment = c.chunkContent("d4", "comments", "T", { body }, {}, "comments");
  const asDefault = c.chunkContent("d5", "misc", "T", { body }, {}, "misc");
  assert.ok(asComment.length > asDefault.length, "smaller per-type size must produce more chunks");
}

// 5. Empty content → no chunks (no crash).
{
  assert.equal(c.chunkContent("d6", "docs", "T", {}).length, 0, "empty content yields no chunks");
}

// ── Backfill decision logic (pure) ───────────────────────────────────────────
import { newJob, decideDoc, contentHash, isLeaseFree, isActive } from "./services/backfill-types";

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
// contentHash: deterministic + sensitive to indexed content, incl. NESTED/ARRAY
// (the v0.7.1 fix — must match the chunker's extraction surface).
{
  const a = contentHash("Title", { body: "hello there" });
  const b = contentHash("Title", { body: "hello there", id: "ignored", url: "http://skip" });
  const c = contentHash("Title", { body: "changed content here" });
  assert.equal(a, b, "hash ignores skipped keys (id/url)");
  assert.notEqual(a, c, "hash changes when body changes");
  assert.match(a, /^[0-9a-f]{8}$/, "hash is 8 hex chars");

  // The bug that was: a change buried in a nested/array body (Portable-Text-like)
  // must change the hash, or backfill would wrongly skip a genuinely-edited post.
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

console.log("emdash-rag self-check: all assertions passed ✅");
