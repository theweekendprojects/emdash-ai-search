/**
 * Minimal SSE helpers shared by the streaming transports.
 *
 * Cloudflare's streaming responses (Workers AI + AI Search chat/completions) are
 * Server-Sent Events: `data: {json}\n\n` lines, a terminal `data: [DONE]`, and —
 * for AI Search — a leading `event: chunks` line with the retrieved sources.
 *
 * `sseTextDeltas` turns a fetch Response body into an async iterable of the
 * incremental assistant text (`choices[0].delta.content`). It ignores the
 * `chunks` event and stops at `[DONE]`.
 */

/** Async-iterate the incremental text deltas from an OpenAI-style SSE stream. */
export async function* sseTextDeltas(res: Response): AsyncGenerator<string> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Process complete SSE events (separated by a blank line).
      let sep: number;
      while ((sep = indexOfEventBoundary(buffer)) !== -1) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep).replace(/^(\r?\n)+/, "");
        const delta = deltaFromEvent(rawEvent);
        if (delta === DONE) return;
        if (delta) yield delta;
      }
    }
    // Flush any trailing event without a final blank line.
    const delta = deltaFromEvent(buffer);
    if (delta && delta !== DONE) yield delta;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}

const DONE = Symbol("done") as unknown as string;

function indexOfEventBoundary(s: string): number {
  const nn = s.indexOf("\n\n");
  const rnrn = s.indexOf("\r\n\r\n");
  if (nn === -1) return rnrn;
  if (rnrn === -1) return nn;
  return Math.min(nn, rnrn);
}

/** Extract the text delta from one SSE event block, or DONE, or "" (skip). */
function deltaFromEvent(block: string): string {
  // Collect all `data:` lines in the event (ignore `event:` / `id:` lines).
  const dataLines = block
    .split(/\r?\n/)
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim());
  if (dataLines.length === 0) return "";
  const payload = dataLines.join("\n");
  if (payload === "[DONE]") return DONE;
  try {
    const json = JSON.parse(payload);
    // OpenAI-compatible chunk: choices[0].delta.content
    const content = json?.choices?.[0]?.delta?.content;
    if (typeof content === "string") return content;
    // Workers AI raw stream sometimes uses { response: "..." }
    if (typeof json?.response === "string") return json.response;
    return "";
  } catch {
    // The `event: chunks` payload is a JSON array of sources — not text. Skip.
    return "";
  }
}
