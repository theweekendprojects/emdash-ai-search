/**
 * The two BackendFactory implementations — one per plugin runtime mode.
 *
 *   SandboxedBackendFactory → REST over ctx.http (needs CF account id + token).
 *   NativeBackendFactory     → Cloudflare bindings (env.AI, env.VECTORIZE,
 *                              env.AI_SEARCH namespace, env.<R2 bucket>). Tokenless.
 *
 * Each builds the SearchBackend chosen by settings.kbBackend:
 *   "ai-search" → AiSearchBackend (managed; default)
 *   "vectorize" → VectorizeBackend (self-managed pipeline)
 */

import type { Ctx } from "./services/host";
import type { R2Bucket } from "./services/host";
import type { SearchSettings } from "./services/types";
import type { SearchBackend } from "./services/search-backend";
import type { BackendFactory } from "./core";

import { AiSearchBackend } from "./services/ai-search-backend";
import { VectorizeBackend } from "./services/vectorize-backend";

import { RestEmbedder } from "./services/embedding.rest";
import { RestVectorBackend } from "./services/vector-store.rest";
import { RestGenerator } from "./services/generator.rest";
import { RestAiSearchClient } from "./services/ai-search-client";
import { RestR2Writer } from "./services/r2-writer";

import { BindingEmbedder, type AiBinding } from "./services/embedding.binding";
import { BindingVectorBackend, type VectorizeBinding } from "./services/vector-store.binding";
import { BindingGenerator, type AiChatBinding } from "./services/generator.binding";
import { BindingAiSearchClient, type AiSearchNamespaceBinding } from "./services/ai-search-client";
import { BindingR2Writer } from "./services/r2-writer";

// ── Sandboxed (REST over ctx.http) ──────────────────────────────────────────

export class SandboxedBackendFactory implements BackendFactory {
  build(ctx: Ctx, settings: SearchSettings): SearchBackend {
    if (!ctx.http) throw new Error("AI search (sandboxed): network:request capability missing (ctx.http)");
    if (!settings.cfAccountId || !settings.cfApiToken) {
      throw new Error("AI search (sandboxed): Cloudflare account id / API token not set in Settings");
    }

    if (settings.kbBackend === "vectorize") {
      const embedder = new RestEmbedder(ctx.http, settings.cfAccountId, settings.cfApiToken, settings.embeddingModel);
      const vectors = new RestVectorBackend(ctx.http, settings.cfAccountId, settings.cfApiToken, settings.vectorizeIndex);
      const generator = new RestGenerator(ctx.http, settings.cfAccountId, settings.cfApiToken, settings.chatModel);
      return new VectorizeBackend(ctx, settings, embedder, vectors, generator);
    }

    // default: managed AI Search
    const client = new RestAiSearchClient(ctx.http, settings.cfAccountId, settings.cfApiToken, settings.aiSearchInstance);
    const r2 = new RestR2Writer(ctx.http, settings.cfAccountId, settings.cfApiToken, settings.aiSearchBucket);
    return new AiSearchBackend(ctx, client, r2, { resultsLimit: settings.resultsLimit, chatModel: settings.chatModel });
  }
}

// ── Native (Cloudflare bindings) ─────────────────────────────────────────────

/** The bindings the native entry reads from `cloudflare:workers`. */
export interface NativeBindings {
  AI?: AiBinding & AiChatBinding;
  VECTORIZE?: VectorizeBinding;
  AI_SEARCH?: AiSearchNamespaceBinding;
  R2?: R2Bucket; // the bucket the AI Search instance indexes
}

export class NativeBackendFactory implements BackendFactory {
  constructor(private bindings: NativeBindings) {}

  build(ctx: Ctx, settings: SearchSettings): SearchBackend {
    const b = this.bindings;

    if (settings.kbBackend === "vectorize") {
      if (!b.AI) throw new Error("AI search (native): AI binding missing (add [ai] to wrangler config)");
      if (!b.VECTORIZE) throw new Error("AI search (native): VECTORIZE binding missing (add [[vectorize]])");
      const embedder = new BindingEmbedder(b.AI, settings.embeddingModel);
      const vectors = new BindingVectorBackend(b.VECTORIZE);
      const generator = new BindingGenerator(b.AI, settings.chatModel);
      return new VectorizeBackend(ctx, settings, embedder, vectors, generator);
    }

    // default: managed AI Search
    if (!b.AI_SEARCH) throw new Error("AI search (native): AI_SEARCH namespace binding missing (add [[ai_search_namespaces]])");
    if (!b.R2) throw new Error("AI search (native): R2 bucket binding missing (add the [[r2_buckets]] the instance indexes)");
    const client = new BindingAiSearchClient(b.AI_SEARCH.get(settings.aiSearchInstance));
    const r2 = new BindingR2Writer(b.R2);
    return new AiSearchBackend(ctx, client, r2, { resultsLimit: settings.resultsLimit, chatModel: settings.chatModel });
  }
}
