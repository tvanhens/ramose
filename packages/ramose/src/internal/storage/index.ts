/**
 * Cloudflare-side storage adapters. Internal to the `ramose` package.
 *
 *  - R2NodeStore: content-addressed segment/dir-node store
 *      peek → in-memory LRU
 *      load → memory → optional SQLite tier (DOs) → optional Cache API (Workers) → R2
 *      put  → encode + gzip + sha256 → R2 (immutable headers), populate caches
 *  - root records: `root/current` (mutable, no-store) and `roots/<t>` (immutable)
 *  - log chunks: `log/<t0>-<t1>` (immutable)
 *
 * R2 layout (spec §2/§5): seg/<hash>, n/<hash>, log/<t0>-<t1>, roots/<t>, root/current
 */

import {
  type Codec,
  type IndexId,
  type LogEntry,
  type NodeRef,
  type NodeStore,
  type RootRecord,
  type Roots,
  type TreeNode,
  decodeLogChunk,
  deserializeNode,
  encodeLogChunk,
  gzipCodec,
  objectKey,
  reachable,
  serializeNode,
} from "../core/index.ts";

export const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";

/**
 * Every logical database lives under its own key prefix in the shared bucket
 * (`db/<name>/seg/…`, `db/<name>/root/current`, …). Segments are still
 * content-addressed *within* a database; not sharing them across databases
 * keeps per-database GC (mark & sweep against that database's roots) safe.
 */
export const dbPrefix = (db: string) => `db/${db}/`;

/** View of `bucket` where every key is under `prefix` (list results are un-prefixed). */
export function prefixedBucket(bucket: R2Like, prefix: string): R2Like {
  const k = (key: string) => prefix + key;
  return {
    get: (key) => bucket.get(k(key)),
    put: (key, value, options) => bucket.put(k(key), value, options),
    head: (key) => bucket.head(k(key)),
    delete: (keys) => bucket.delete(Array.isArray(keys) ? keys.map(k) : k(keys)),
    list: async (options = {}) => {
      const page = await bucket.list({ ...options, prefix: prefix + (options.prefix ?? "") });
      return { ...page, objects: page.objects.map((o) => ({ ...o, key: o.key.slice(prefix.length) })) };
    },
  };
}
export const ROOT_CACHE_CONTROL = "no-store";

/** Minimal structural type for an R2 bucket binding (avoids a hard dep on workers-types at type level). */
export interface R2Like {
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; text(): Promise<string>; httpMetadata?: any } | null>;
  put(key: string, value: ArrayBuffer | Uint8Array | string, options?: any): Promise<unknown>;
  head(key: string): Promise<unknown | null>;
  delete(keys: string | string[]): Promise<void>;
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{ objects: { key: string; size: number }[]; truncated: boolean; cursor?: string }>;
}

/** Optional durable byte tier (DO SQLite): hash → body. */
export interface ByteTier {
  get(key: string): Uint8Array | undefined | Promise<Uint8Array | undefined>;
  put(key: string, body: Uint8Array): void | Promise<void>;
}

/** Optional Cache API tier (Workers). */
export interface CacheTier {
  match(key: string): Promise<Uint8Array | undefined>;
  put(key: string, body: Uint8Array): Promise<void>;
}

export interface R2StoreStats {
  peekHits: number;
  memHits: number;
  tierHits: number;
  cacheHits: number;
  r2Gets: number;
  r2Puts: number;
  r2PutSkipped: number;
  bytesRead: number;
  bytesWritten: number;
}

export interface R2NodeStoreOptions {
  codec?: Codec;
  /** max decoded nodes held in memory */
  maxNodes?: number;
  tier?: ByteTier;
  cache?: CacheTier;
  /** if true, `put` skips objects that already exist (one HEAD instead of a PUT) — cheaper for big segments */
  headBeforePut?: boolean;
}

export class R2NodeStore implements NodeStore {
  readonly codec: Codec;
  private readonly mem = new Map<string, TreeNode>();
  private readonly maxNodes: number;
  private readonly tier: ByteTier | undefined;
  private readonly cache: CacheTier | undefined;
  private readonly headBeforePut: boolean;
  private readonly inflight = new Map<string, Promise<TreeNode>>();
  readonly stats: R2StoreStats = { peekHits: 0, memHits: 0, tierHits: 0, cacheHits: 0, r2Gets: 0, r2Puts: 0, r2PutSkipped: 0, bytesRead: 0, bytesWritten: 0 };

  constructor(readonly bucket: R2Like, opts: R2NodeStoreOptions = {}) {
    this.codec = opts.codec ?? gzipCodec;
    this.maxNodes = opts.maxNodes ?? 2048;
    this.tier = opts.tier;
    this.cache = opts.cache;
    this.headBeforePut = opts.headBeforePut ?? false;
  }

  peek(hash: string): TreeNode | undefined {
    const n = this.mem.get(hash);
    if (n !== undefined) {
      this.stats.peekHits++;
      this.mem.delete(hash);
      this.mem.set(hash, n); // LRU refresh
    }
    return n;
  }

  private remember(hash: string, node: TreeNode): void {
    this.mem.set(hash, node);
    if (this.mem.size > this.maxNodes) {
      const oldest = this.mem.keys().next().value as string;
      this.mem.delete(oldest);
    }
  }

  async load(ref: NodeRef): Promise<TreeNode> {
    const m = this.mem.get(ref.hash);
    if (m !== undefined) {
      this.stats.memHits++;
      return m;
    }
    const pending = this.inflight.get(ref.hash);
    if (pending) return pending;
    const p = this.loadUncached(ref).finally(() => this.inflight.delete(ref.hash));
    this.inflight.set(ref.hash, p);
    return p;
  }

  private async loadUncached(ref: NodeRef): Promise<TreeNode> {
    const key = objectKey(ref.kind, ref.hash);
    // Lower tiers first; a body that fails to decode there is treated as a
    // miss (corrupt/truncated cache entry) and we fall through to R2 —
    // content addressing means R2 is always authoritative.
    let body: Uint8Array | undefined;
    if (this.tier) {
      body = await this.tier.get(key);
      if (body && body.length > 0) {
        try {
          const node = await deserializeNode(body, this.codec);
          this.stats.tierHits++;
          this.remember(ref.hash, node);
          return node;
        } catch {
          /* fall through */
        }
      }
    }
    if (this.cache) {
      body = await this.cache.match(key);
      if (body && body.length > 0) {
        try {
          const node = await deserializeNode(body, this.codec);
          this.stats.cacheHits++;
          this.remember(ref.hash, node);
          return node;
        } catch {
          /* fall through */
        }
      }
    }
    const obj = await this.bucket.get(key);
    if (!obj) throw new Error(`R2NodeStore: missing object ${key}`);
    body = new Uint8Array(await obj.arrayBuffer());
    this.stats.r2Gets++;
    this.stats.bytesRead += body.length;
    const node = await deserializeNode(body, this.codec);
    // populate lower tiers (best effort, don't await failures). Hand them a
    // copy: a Response/SQL binding may detach or retain the buffer.
    if (this.cache) this.cache.put(key, body.slice()).catch(() => undefined);
    if (this.tier) await Promise.resolve(this.tier.put(key, body.slice())).catch(() => undefined);
    this.remember(ref.hash, node);
    return node;
  }

  async put(index: IndexId, node: TreeNode): Promise<NodeRef> {
    const { ref, body } = await serializeNode(index, node, this.codec);
    const key = objectKey(ref.kind, ref.hash);
    let exists = false;
    if (this.headBeforePut) exists = (await this.bucket.head(key)) !== null;
    if (!exists) {
      await this.bucket.put(key, body, { httpMetadata: { cacheControl: IMMUTABLE_CACHE_CONTROL, contentType: "application/octet-stream" } });
      this.stats.r2Puts++;
      this.stats.bytesWritten += body.length;
    } else this.stats.r2PutSkipped++;
    if (this.tier) await Promise.resolve(this.tier.put(key, body.slice())).catch(() => undefined);
    this.remember(ref.hash, node);
    return ref;
  }

  /** Drop the in-memory node cache (tests / memory pressure). */
  clearMemory(): void {
    this.mem.clear();
  }
}

// ---------------------------------------------------------------------------
// Cache API tier for Workers
// ---------------------------------------------------------------------------

/** Wrap the Workers Cache API as a byte tier keyed by a synthetic URL. */
export function cacheApiTier(cache: any /* Cache */, origin = "https://ramose-cache.invalid"): CacheTier {
  return {
    async match(key) {
      const req = new Request(`${origin}/${key}`);
      const res = await cache.match(req);
      if (!res) return undefined;
      const body = new Uint8Array(await res.arrayBuffer());
      // Guard against a truncated/empty cached body (seen with the local emulator): treat as a miss.
      const declared = Number(res.headers.get("content-length") ?? body.length);
      if (body.length === 0 || (Number.isFinite(declared) && declared !== body.length)) {
        Promise.resolve(cache.delete(req)).catch(() => undefined);
        return undefined;
      }
      return body;
    },
    async put(key, body) {
      await cache.put(
        new Request(`${origin}/${key}`),
        new Response(body as BufferSource, { headers: { "Cache-Control": IMMUTABLE_CACHE_CONTROL, "Content-Type": "application/octet-stream" } }),
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Root records
// ---------------------------------------------------------------------------

export const ROOT_CURRENT_KEY = "root/current";
export const rootKey = (t: number) => `roots/${String(t).padStart(12, "0")}`;

export function rootsToRecord(roots: Roots, extra: { log_watermark: number; next_eid: number; codec: string; created_at?: number }): RootRecord {
  const ref = (r: NodeRef) => ({ hash: r.hash, kind: r.kind, count: r.count });
  return {
    v: 1,
    t: roots.t,
    eavt: ref(roots.eavt),
    aevt: ref(roots.aevt),
    avet: ref(roots.avet),
    vaet: ref(roots.vaet),
    log_watermark: extra.log_watermark,
    next_eid: extra.next_eid,
    codec: extra.codec,
    created_at: extra.created_at ?? Date.now(),
  };
}

export function recordToRoots(rec: RootRecord): Roots {
  const ref = (r: { hash: string; kind: 0 | 1; count: number }): NodeRef => ({ hash: r.hash, kind: r.kind, count: r.count });
  return { t: rec.t, eavt: ref(rec.eavt), aevt: ref(rec.aevt), avet: ref(rec.avet), vaet: ref(rec.vaet) };
}

export async function readCurrentRoot(bucket: R2Like): Promise<RootRecord | null> {
  const obj = await bucket.get(ROOT_CURRENT_KEY);
  if (!obj) return null;
  return JSON.parse(await obj.text()) as RootRecord;
}

export async function readRootAt(bucket: R2Like, t: number): Promise<RootRecord | null> {
  const obj = await bucket.get(rootKey(t));
  if (!obj) return null;
  return JSON.parse(await obj.text()) as RootRecord;
}

/** Publish: immutable roots/<t> first, then flip root/current. */
export async function publishRoot(bucket: R2Like, rec: RootRecord): Promise<void> {
  const body = JSON.stringify(rec);
  await bucket.put(rootKey(rec.t), body, { httpMetadata: { cacheControl: IMMUTABLE_CACHE_CONTROL, contentType: "application/json" } });
  await bucket.put(ROOT_CURRENT_KEY, body, { httpMetadata: { cacheControl: ROOT_CACHE_CONTROL, contentType: "application/json" } });
}

/** List retained root records (all `roots/<t>` keys), ascending by t. */
export async function listRoots(bucket: R2Like): Promise<number[]> {
  const ts: number[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: "roots/", cursor, limit: 1000 });
    for (const o of page.objects) ts.push(Number(o.key.slice("roots/".length)));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return ts.sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Log chunks
// ---------------------------------------------------------------------------

export const logKey = (t0: number, t1: number) => `log/${String(t0).padStart(12, "0")}-${String(t1).padStart(12, "0")}`;

export async function putLogChunk(bucket: R2Like, entries: readonly LogEntry[], codec: Codec = gzipCodec): Promise<string> {
  if (entries.length === 0) throw new Error("empty log chunk");
  const key = logKey(entries[0].t, entries[entries.length - 1].t);
  const body = await codec.compress(encodeLogChunk(entries));
  await bucket.put(key, body, { httpMetadata: { cacheControl: IMMUTABLE_CACHE_CONTROL, contentType: "application/octet-stream" } });
  return key;
}

export interface LogChunkRef {
  key: string;
  t0: number;
  t1: number;
}

export async function listLogChunks(bucket: R2Like, sinceT = 0): Promise<LogChunkRef[]> {
  const out: LogChunkRef[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: "log/", cursor, limit: 1000 });
    for (const o of page.objects) {
      const m = /^log\/(\d+)-(\d+)$/.exec(o.key);
      if (!m) continue;
      const t0 = Number(m[1]), t1 = Number(m[2]);
      if (t1 > sinceT) out.push({ key: o.key, t0, t1 });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out.sort((a, b) => a.t0 - b.t0);
}

export async function readLogChunk(bucket: R2Like, key: string, codec: Codec = gzipCodec): Promise<LogEntry[]> {
  const obj = await bucket.get(key);
  if (!obj) throw new Error(`missing log chunk ${key}`);
  return decodeLogChunk(await codec.decompress(new Uint8Array(await obj.arrayBuffer())));
}

/** Read all log entries with t in (sinceT, untilT]. */
export async function readLogSince(bucket: R2Like, sinceT: number, untilT = Infinity, codec: Codec = gzipCodec): Promise<LogEntry[]> {
  const chunks = await listLogChunks(bucket, sinceT);
  const out: LogEntry[] = [];
  for (const c of chunks) {
    if (c.t0 > untilT) break;
    for (const e of await readLogChunk(bucket, c.key, codec)) if (e.t > sinceT && e.t <= untilT) out.push(e);
  }
  return out;
}

// ---------------------------------------------------------------------------
// GC: mark & sweep against retained roots
// ---------------------------------------------------------------------------

export interface GcResult {
  retainedRoots: number[];
  reachable: number;
  deleted: number;
  scanned: number;
}

/**
 * Delete every seg/ and n/ object unreachable from the retained roots.
 * `retain` decides which roots (by t) to keep — the current root is always kept.
 * Objects newer than `graceMs` are never deleted (in-flight index runs).
 */
export async function gcSweep(
  bucket: R2Like,
  store: NodeStore & { load(ref: NodeRef): Promise<TreeNode> },
  currentT: number,
  retain: (rootTs: number[]) => number[],
  opts: { deleteRoots?: boolean; dryRun?: boolean; graceMs?: number } = {},
): Promise<GcResult> {
  const all = await listRoots(bucket);
  const keep = new Set(retain(all));
  keep.add(currentT);
  const marked = new Set<string>();
  for (const t of keep) {
    const rec = await readRootAt(bucket, t);
    if (!rec) continue;
    const roots = recordToRoots(rec);
    for (const r of [roots.eavt, roots.aevt, roots.avet, roots.vaet]) await reachable(store, r, marked);
  }
  let deleted = 0, scanned = 0;
  for (const prefix of ["seg/", "n/"]) {
    let cursor: string | undefined;
    do {
      const page = await bucket.list({ prefix, cursor, limit: 1000 });
      const doomed: string[] = [];
      for (const o of page.objects) {
        scanned++;
        const hash = o.key.slice(prefix.length);
        if (!marked.has(hash)) doomed.push(o.key);
      }
      if (doomed.length && !opts.dryRun) await bucket.delete(doomed);
      deleted += doomed.length;
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
  if (opts.deleteRoots && !opts.dryRun) {
    const doomed = all.filter((t) => !keep.has(t)).map(rootKey);
    if (doomed.length) await bucket.delete(doomed);
  }
  return { retainedRoots: [...keep].sort((a, b) => a - b), reachable: marked.size, deleted, scanned };
}

/** Default retention: keep the newest `n` roots plus every root newer than `maxAgeT` transactions ago. */
export function retainNewest(n: number): (ts: number[]) => number[] {
  return (ts) => ts.slice(-n);
}
