/**
 * Chunking Service
 *
 * Ported from SonicJS ai-search-plugin/services/chunking.service.ts
 * (lane711/sonicjs, MIT). Pure logic, no host bindings — the cleanest part of
 * the port.
 *
 * Change vs. SonicJS: in the original, `getOptimalChunkSize()` existed but was
 * never called — `splitIntoChunks` hardcoded CHUNK_SIZE. Here the per-type size
 * is actually threaded through so the knob does something.
 */

export interface ContentChunk {
  id: string;
  content_id: string;
  collection_id: string;
  title: string;
  text: string;
  chunk_index: number;
  metadata: Record<string, unknown>;
}

/**
 * Extract the searchable text from a content object. This is the AUTHORITATIVE
 * surface that gets indexed — the chunker AND the backfill content-hash both use
 * it, so change-detection matches what's actually embedded (incl. nested objects
 * and arrays, e.g. Portable Text). Skips ids/urls/short strings.
 *
 * Exported so `backfill-types.contentHash` hashes exactly this, not a narrower
 * top-level-fields-only view (which would wrongly skip changed nested content).
 */
export function extractIndexableText(data: unknown): string {
  const parts: string[] = [];
  const record = (data ?? {}) as Record<string, unknown>;

  for (const key of ["title", "name", "description", "content", "body", "text", "summary"]) {
    if (record[key]) parts.push(String(record[key]));
  }

  const skipKeys = new Set(["id", "slug", "url", "image", "thumbnail", "metadata"]);
  const walk = (obj: unknown): void => {
    if (typeof obj === "string") {
      if (obj.length > 10 && !obj.startsWith("http")) parts.push(obj);
    } else if (Array.isArray(obj)) {
      obj.forEach(walk);
    } else if (obj && typeof obj === "object") {
      for (const [k, v] of Object.entries(obj)) {
        if (!skipKeys.has(k.toLowerCase())) walk(v);
      }
    }
  };
  walk(data);

  return parts.join("\n\n").trim();
}

export class ChunkingService {
  private readonly CHUNK_SIZE = 500; // approximate words
  private readonly CHUNK_OVERLAP = 50;

  chunkContent(
    contentId: string,
    collectionId: string,
    title: string,
    data: unknown,
    metadata: Record<string, unknown> = {},
    contentType?: string,
  ): ContentChunk[] {
    const text = this.extractText(data);
    if (!text || text.trim().length === 0) {
      return [];
    }

    const chunkSize = contentType ? this.getOptimalChunkSize(contentType) : this.CHUNK_SIZE;
    const textChunks = this.splitIntoChunks(text, chunkSize);

    return textChunks.map((chunkText, index) => ({
      id: `${contentId}_chunk_${index}`,
      content_id: contentId,
      collection_id: collectionId,
      title,
      text: chunkText,
      chunk_index: index,
      metadata: { ...metadata, total_chunks: textChunks.length },
    }));
  }

  chunkContentBatch(
    items: Array<{
      id: string;
      collection_id: string;
      title: string;
      data: unknown;
      metadata?: Record<string, unknown>;
      content_type?: string;
    }>,
  ): ContentChunk[] {
    const all: ContentChunk[] = [];
    for (const item of items) {
      all.push(
        ...this.chunkContent(
          item.id,
          item.collection_id,
          item.title,
          item.data,
          item.metadata ?? {},
          item.content_type,
        ),
      );
    }
    return all;
  }

  /** Extract searchable text from a content object, skipping ids/urls/short strings. */
  private extractText(data: unknown): string {
    return extractIndexableText(data);
  }

  /** Word-based split with overlap. */
  private splitIntoChunks(text: string, chunkSize: number): string[] {
    const words = text.split(/\s+/);
    if (words.length <= chunkSize) return [text];

    const chunks: string[] = [];
    let start = 0;
    while (start < words.length) {
      const end = Math.min(start + chunkSize, words.length);
      chunks.push(words.slice(start, end).join(" "));
      start += chunkSize - this.CHUNK_OVERLAP;
      if (start >= words.length - this.CHUNK_OVERLAP) break;
    }
    return chunks;
  }

  getOptimalChunkSize(contentType: string): number {
    switch (contentType) {
      case "blog_post":
      case "articles":
        return 600;
      case "products":
      case "pages":
        return 400;
      case "messages":
      case "comments":
        return 200;
      default:
        return this.CHUNK_SIZE;
    }
  }
}
