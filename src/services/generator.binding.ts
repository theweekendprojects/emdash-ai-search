/**
 * Generator — binding implementation (native / trusted mode).
 *
 * Calls the Workers AI binding directly: env.AI.run(model, { messages }).
 * Tokenless. Non-streaming returns { response: string }; streaming returns a
 * ReadableStream of SSE bytes (choices[0].delta.content deltas).
 *
 * Reuses the same AiBinding shape as the embedder, extended with a `messages`
 * input variant (the binding's run() accepts either text or messages depending
 * on the model).
 */

import type { Generator, ChatMessage } from "./ports";
import { sseTextDeltas } from "./sse";

export interface AiChatBinding {
  run(
    model: string,
    inputs: { messages: ChatMessage[]; max_tokens?: number; stream?: boolean },
  ): Promise<{ response?: string } | ReadableStream>;
}

export class BindingGenerator implements Generator {
  constructor(
    private ai: AiChatBinding,
    private model: string,
  ) {}

  async generate(messages: ChatMessage[], opts?: { maxTokens?: number }): Promise<string> {
    const res = (await this.ai.run(this.model, {
      messages,
      max_tokens: opts?.maxTokens ?? 512,
      stream: false,
    })) as { response?: string };
    if (typeof res?.response !== "string") throw new Error("AI binding returned no response text");
    return res.response;
  }

  async *generateStream(messages: ChatMessage[], opts?: { maxTokens?: number }): AsyncIterable<string> {
    const stream = (await this.ai.run(this.model, {
      messages,
      max_tokens: opts?.maxTokens ?? 512,
      stream: true,
    })) as ReadableStream;
    // The binding returns a ReadableStream of SSE bytes; wrap it in a Response so
    // the shared SSE parser can consume it uniformly.
    yield* sseTextDeltas(new Response(stream));
  }
}
