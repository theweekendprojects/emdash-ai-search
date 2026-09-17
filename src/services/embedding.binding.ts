/**
 * Embedder — binding implementation (native / trusted mode).
 *
 * Calls the Workers AI binding directly: env.AI.run(model, { text }).
 * No API token — auth is the binding, exactly like the Cloudflare Email plugin
 * uses the `send_email` binding. Only available to a trusted (native) plugin
 * running in the host Worker isolate.
 */

import type { Embedder } from "./ports";
import { preprocess } from "./embedding.rest";

/** Minimal shape of the Workers AI binding. */
export interface AiBinding {
  run(model: string, inputs: { text: string | string[] }): Promise<{ data?: number[][] }>;
}

export class BindingEmbedder implements Embedder {
  constructor(
    private ai: AiBinding,
    private model: string,
  ) {}

  async embed(text: string): Promise<number[]> {
    const res = await this.ai.run(this.model, { text: preprocess(text) });
    const vec = res?.data?.[0];
    if (!vec) throw new Error("No embedding returned from AI binding");
    return vec;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const batchSize = 100;
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize).map(preprocess);
      const res = await this.ai.run(this.model, { text: batch });
      const data = res?.data;
      if (!Array.isArray(data)) throw new Error("AI binding returned no data array");
      out.push(...data);
    }
    return out;
  }
}
