/**
 * ChatService — retrieval-augmented generation (the "chatbot").
 *
 * The G that SonicJS's ai-search never had: retrieve top chunks (RagService),
 * build a grounded prompt, call the Generator, return the answer + citations.
 *
 * Grounding rule baked into the system prompt: answer ONLY from the provided
 * context; if the context doesn't cover it, say so. This is what keeps a RAG
 * chatbot from hallucinating over your content.
 */

import type { RagService } from "./custom-rag.service";
import type { Generator, ChatMessage } from "./ports";
import type { RagSettings, SearchFilters, ChatCitation, ChatResponse } from "./types";

const SYSTEM_PROMPT =
  "You are a helpful assistant that answers questions using ONLY the provided context. " +
  "If the context does not contain the answer, say you don't have that information — do not invent facts. " +
  "Be concise and cite nothing inline; the caller attaches sources separately.";

export class ChatService {
  constructor(
    private rag: RagService,
    private generator: Generator,
    private settings: RagSettings,
  ) {}

  async ask(question: string, filters?: SearchFilters): Promise<ChatResponse> {
    const q = question.trim();
    if (!q) return { answer: "Please ask a question.", citations: [], usedChunks: 0 };

    const chunks = await this.rag.retrieveChunks(q, this.settings.chatTopK, filters);

    if (chunks.length === 0) {
      return {
        answer: "I don't have any indexed content that covers that.",
        citations: [],
        usedChunks: 0,
      };
    }

    // Build the grounding context. Number the sources so the model can reason
    // over distinct passages; we return citation metadata separately.
    const context = chunks
      .map((c, i) => `[Source ${i + 1}: ${c.title}]\n${c.text}`)
      .join("\n\n---\n\n");

    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `Context:\n\n${context}\n\n---\n\nQuestion: ${q}` },
    ];

    const answer = await this.generator.generate(messages, { maxTokens: this.settings.maxTokens });

    // Dedupe citations by document, keeping the best score.
    const byDoc = new Map<string, ChatCitation>();
    for (const c of chunks) {
      const prev = byDoc.get(c.contentId);
      if (!prev || c.score > prev.score) {
        byDoc.set(c.contentId, {
          contentId: c.contentId,
          title: c.title,
          collectionId: c.collectionId,
          score: c.score,
        });
      }
    }

    return {
      answer: answer.trim(),
      citations: [...byDoc.values()].sort((a, b) => b.score - a.score),
      usedChunks: chunks.length,
    };
  }

  /**
   * Streaming variant: same retrieval + grounded prompt, but yields answer text
   * deltas from the generator instead of buffering. Citations aren't streamed
   * (the widget shows them from a separate non-streaming call, or omits them).
   */
  async *askStream(question: string, filters?: SearchFilters): AsyncIterable<string> {
    const q = question.trim();
    if (!q) {
      yield "Please ask a question.";
      return;
    }
    const chunks = await this.rag.retrieveChunks(q, this.settings.chatTopK, filters);
    if (chunks.length === 0) {
      yield "I don't have any indexed content that covers that.";
      return;
    }
    const context = chunks.map((c, i) => `[Source ${i + 1}: ${c.title}]\n${c.text}`).join("\n\n---\n\n");
    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `Context:\n\n${context}\n\n---\n\nQuestion: ${q}` },
    ];
    yield* this.generator.generateStream(messages, { maxTokens: this.settings.maxTokens });
  }
}
