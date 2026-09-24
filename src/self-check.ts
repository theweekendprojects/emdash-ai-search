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

// ── extractIndexableText: skips urls + noise KEYS, keeps prose (any length) ──
// Noise is filtered by field ROLE (key name), not by string length. The old
// `length > 10` filter dropped real short prose (short paragraphs, 1–2 word
// headings, list items), which is exactly why "the full post" never reached the
// index. Short prose in a real prose field must be kept.
{
  const text = extractIndexableText({
    url: "https://example.com/ignored",
    slug: "some-slug",
    body: "This is a genuine paragraph of content that should be indexed.",
  });
  assert.ok(!text.includes("example.com"), "urls must be skipped");
  assert.ok(!text.includes("some-slug"), "identifier keys (slug) must be skipped");
  assert.ok(text.includes("genuine paragraph"), "real prose must be kept");

  // A short prose string is real content — keep it (no length floor).
  const shortProse = extractIndexableText({ body: "Ship it." });
  assert.ok(shortProse.includes("Ship it."), "short prose must NOT be dropped by any length filter");

  const nested = extractIndexableText({ blocks: [{ children: [{ text: "nested paragraph of content" }] }] });
  assert.ok(nested.includes("nested paragraph of content"), "must walk nested/array content");
}

// ── Portable Text body: full extraction, short spans kept, no junk/media leak ──
{
  const data = {
    title: "Building for the Long Term",
    excerpt: "The frameworks will change.",
    featured_image: { $media: { url: "https://x/y.jpg", alt: "Code on a monitor", filename: "long-term.jpg" } },
    content: [
      { _type: "block", style: "normal", children: [{ _type: "span", text: "Every few years the industry churns." }] },
      { _type: "block", style: "h2", children: [{ _type: "span", text: "What survives" }] }, // short heading (13 chars)
      { _type: "block", style: "normal", children: [{ _type: "span", text: "Clean data models survive." }] },
    ],
  };
  const text = extractIndexableText(data);
  assert.ok(text.includes("Every few years the industry churns."), "first body paragraph must be indexed");
  assert.ok(text.includes("What survives"), "SHORT headings/spans must be kept (no length filter)");
  assert.ok(text.includes("Clean data models survive."), "later body paragraphs must be indexed");
  assert.ok(!text.includes("[object Object]"), "must NOT stringify block arrays into object junk");
  assert.ok(!text.includes("Code on a monitor"), "image alt text must NOT leak into the body");
  assert.ok(!text.includes("long-term.jpg"), "image filename must NOT leak into the body");
}

// ── Mixed / arbitrary Portable Text: code, image-in-middle, list, callout,
//    table, linked spans, embed — all indexed; media/enum noise excluded. ─────
{
  const data = {
    title: "Mixed Format Post",
    content: [
      { _type: "block", style: "normal", children: [{ _type: "span", text: "Intro before the image." }] },
      { _type: "image", asset: { url: "https://cdn/mid.png" }, alt: "MID ALT LEAK", caption: "Figure 1: the diagram" },
      { _type: "code", language: "js", code: "const x = 42;" },
      { _type: "block", listItem: "bullet", level: 1, children: [{ _type: "span", text: "List item one" }] },
      { _type: "callout", tone: "info", body: [{ _type: "block", children: [{ _type: "span", text: "Callout inner text." }] }] },
      { _type: "table", rows: [{ cells: ["Cell A", "Cell B"] }] },
      {
        _type: "block",
        children: [
          { _type: "span", text: "A link to " },
          { _type: "span", marks: ["m1"], text: "the docs" },
        ],
        markDefs: [{ _key: "m1", _type: "link", href: "https://docs" }],
      },
      { _type: "embed", url: "https://youtu.be/abc", title: "Embedded video title" },
    ],
  };
  const t = extractIndexableText(data);
  for (const want of [
    "Intro before the image.",
    "Figure 1: the diagram", // image CAPTION is prose, kept
    "const x = 42;", // CODE block kept
    "List item one",
    "Callout inner text.", // custom block nested body kept
    "Cell A",
    "Cell B", // table cells kept
    "the docs", // linked span kept
    "Embedded video title", // embed title kept
  ]) {
    assert.ok(t.includes(want), `mixed PT must index: ${want}`);
  }
  for (const noise of ["MID ALT LEAK", "youtu.be", "https://", '"js"', "\ninfo\n"]) {
    assert.ok(!t.includes(noise), `mixed PT must NOT leak: ${noise}`);
  }
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
