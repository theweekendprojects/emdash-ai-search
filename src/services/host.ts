/**
 * Narrow, local views of the real EmDash PluginContext surface this plugin uses.
 *
 * These mirror the shapes documented in EmDash's creating-plugins SKILL.md and
 * storage.md. We keep them local (rather than importing concrete runtime types)
 * so the bundle stays free of the EmDash runtime, exactly as the docs require
 * ("Keep imports from emdash/plugin type-only").
 */

export interface StorageCollection<T = unknown> {
  get(id: string): Promise<T | null>;
  put(id: string, data: T): Promise<void>;
  delete(id: string): Promise<boolean>;
  getMany(ids: string[]): Promise<Map<string, T>>;
  putMany(items: Array<{ id: string; data: T }>): Promise<void>;
  deleteMany(ids: string[]): Promise<number>;
  query(options?: {
    where?: Record<string, unknown>;
    orderBy?: Record<string, "asc" | "desc">;
    limit?: number;
    cursor?: string;
  }): Promise<{ items: Array<{ id: string; data: T }>; cursor?: string; hasMore: boolean }>;
  /** Revision-based read + compare-and-set, for crash-safe lease claiming. */
  getVersioned(id: string): Promise<{ value: T; revision: string } | null>;
  compareAndSet(
    id: string,
    expectedRevision: string | null,
    data: T,
  ): Promise<{ applied: true; revision: string } | { applied: false }>;
}

export interface KVAccess {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  list(prefix?: string): Promise<Array<{ key: string; value: unknown }>>;
}

/**
 * Mirrors EmDash's real ContentItem: no top-level `collection` or `title` — the
 * collection is `type`, and the title lives in `data`. Status is a plain string.
 */
export interface ContentItem {
  id: string;
  type: string;
  slug?: string | null;
  status: string;
  data: Record<string, unknown>;
}

/** EmDash content list filter (the `where` clause): exact match on status/locale. */
export interface ContentListWhere {
  status?: string;
  locale?: string;
}

export interface ContentListOptions {
  limit?: number;
  cursor?: string;
  where?: ContentListWhere;
  orderBy?: Record<string, "asc" | "desc">;
}

/**
 * EmDash content API. NOTE: `list(collection, options)` — collection is a
 * POSITIONAL first arg, and status filtering goes in `options.where.status`
 * (there is no top-level `status` option). `get(collection, id)`.
 */
export interface ContentAccess {
  get(collection: string, id: string): Promise<ContentItem | null>;
  list(
    collection: string,
    options?: ContentListOptions,
  ): Promise<{ items: ContentItem[]; cursor?: string; hasMore: boolean }>;
}

export interface HttpAccess {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

/**
 * R2 bucket binding shape (native mode only). The AI Search backend writes
 * authored pages here so the managed instance can index them. Sandboxed mode
 * has no R2 binding and uses the R2 REST API over ctx.http instead.
 */
export interface R2Bucket {
  put(key: string, value: string | ArrayBuffer | ReadableStream): Promise<unknown>;
  delete(key: string): Promise<void>;
}

export interface LogAccess {
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
}

/** The subset of PluginContext this plugin relies on. */
export interface CronAccess {
  schedule(name: string, opts: { schedule: string }): Promise<void>;
}

export interface Ctx {
  plugin: { id: string; version: string };
  kv: KVAccess;
  storage: Record<string, StorageCollection<any>>;
  log: LogAccess;
  content?: ContentAccess; // present with content:read
  http?: HttpAccess; // present with network:request
  cron?: CronAccess; // present in cron-capable runtime
}
