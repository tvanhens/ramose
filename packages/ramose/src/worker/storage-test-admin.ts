/**
 * Test-only storage exercises over the real Worker R2 and Cache API bindings.
 *
 * The forwarding recorders below never substitute for either binding. This
 * module is reachable only through the gated `/__test__/*` admin route.
 */

import {
  Connection,
  Db,
  FIRST_USER_EID,
  Novelty,
  Schema,
  ValueTag,
  attributeDatoms,
  bootstrapDatoms,
  buildRoots,
  deriveSchema,
  gzipCodec,
  objectKey,
  query,
  treeDepth,
  type Datom,
  type NodeSource,
  type RootRecord,
} from "../internal/core/index.ts";
import {
  R2NodeStore,
  cacheApiTier,
  dbPrefix,
  prefixedBucket,
  publishRoot,
  readCurrentRoot,
  recordToRoots,
  rootsToRecord,
  type CacheTier,
  type R2Like,
  type R2StoreStats,
} from "../internal/storage/index.ts";
import type { RamoseEnv } from "../RamoseEnv.ts";
import { BadRequest, Internal } from "./errors.ts";

const NAME = FIRST_USER_EID;
const CITY = FIRST_USER_EID + 1;
const DEFAULT_ROWS = 800;
const CACHE_ORIGIN = "https://ramose-cache.invalid";

type BucketCalls = {
  readonly get: string[];
  readonly put: string[];
  readonly head: string[];
  readonly delete: string[];
  readonly list: string[];
};

type CacheCalls = {
  readonly match: string[];
  readonly put: string[];
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const recordingBucket = (real: R2Like): { bucket: R2Like; calls: BucketCalls } => {
  const calls: BucketCalls = { get: [], put: [], head: [], delete: [], list: [] };
  return {
    calls,
    bucket: {
      get: (key) => {
        calls.get.push(key);
        return real.get(key);
      },
      put: (key, value, options) => {
        calls.put.push(key);
        return real.put(key, value, options);
      },
      head: (key) => {
        calls.head.push(key);
        return real.head(key);
      },
      delete: (keys) => {
        calls.delete.push(...(Array.isArray(keys) ? keys : [keys]));
        return real.delete(keys);
      },
      list: (options = {}) => {
        calls.list.push(options.prefix ?? "");
        return real.list(options);
      },
    },
  };
};

const recordingCache = (
  real: CacheTier,
): { tier: CacheTier; calls: CacheCalls; settle: () => Promise<void> } => {
  const calls: CacheCalls = { match: [], put: [] };
  const pending = new Set<Promise<void>>();
  return {
    calls,
    tier: {
      match: (key) => {
        calls.match.push(key);
        return real.match(key);
      },
      put: (key, body) => {
        calls.put.push(key);
        const operation = real.put(key, body);
        let settled!: Promise<void>;
        settled = operation.catch(() => undefined).finally(() => pending.delete(settled));
        pending.add(settled);
        return operation;
      },
    },
    settle: async () => {
      while (pending.size > 0) await Promise.all([...pending]);
    },
  };
};

const statsDelta = (after: R2StoreStats, before: R2StoreStats): R2StoreStats => ({
  peekHits: after.peekHits - before.peekHits,
  memHits: after.memHits - before.memHits,
  tierHits: after.tierHits - before.tierHits,
  cacheHits: after.cacheHits - before.cacheHits,
  r2Gets: after.r2Gets - before.r2Gets,
  r2Puts: after.r2Puts - before.r2Puts,
  r2PutSkipped: after.r2PutSkipped - before.r2PutSkipped,
  bytesRead: after.bytesRead - before.bytesRead,
  bytesWritten: after.bytesWritten - before.bytesWritten,
});

const snapshotStats = (store: R2NodeStore): R2StoreStats => ({ ...store.stats });

const dbAt = async (store: NodeSource, rec: RootRecord): Promise<Db> => {
  const roots = recordToRoots(rec);
  const schema = await deriveSchema(store, roots);
  return new Db({
    store,
    roots,
    novelty: new Novelty(),
    basisT: rec.t,
    schema,
    nextEid: rec.next_eid,
  });
};

const dataset = (db: string, rows: number): Datom[] => {
  const out: Datom[] = [
    ...attributeDatoms(
      NAME,
      { ident: ":p/name", valueType: ":db.type/string", index: true },
      2,
    ),
    ...attributeDatoms(
      CITY,
      { ident: ":p/city", valueType: ":db.type/string", index: true },
      2,
    ),
  ];
  for (let i = 0; i < rows; i++) {
    const e = FIRST_USER_EID + 100 + i;
    out.push({ e, a: NAME, vt: ValueTag.Str, v: `${db}:n${i}`, t: 3, op: true });
    out.push({ e, a: CITY, vt: ValueTag.Str, v: `${db}:c${i % 10}`, t: 3, op: true });
  }
  return out;
};

const queryText = (db: string): string =>
  `[:find ?n :where [?e :p/city ${JSON.stringify(`${db}:c3`)}] [?e :p/name ?n]]`;

const workerCache = (): Cache => {
  const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
  if (cache === undefined) throw new Internal({ message: "Cache API binding is unavailable" });
  return cache;
};

const cacheRequest = (key: string): Request => new Request(`${CACHE_ORIGIN}/${key}`);

const clearCacheObjects = async (cache: Cache, keys: readonly string[]): Promise<void> => {
  await Promise.all(keys.map((key) => cache.delete(cacheRequest(key))));
};

const corruptCacheObjects = async (cache: Cache, keys: readonly string[]): Promise<void> => {
  await Promise.all(
    keys.map((key) =>
      cache.put(
        cacheRequest(key),
        new Response(new Uint8Array([1, 2, 3, 4, 5]), {
          headers: { "content-type": "application/octet-stream" },
        }),
      ),
    ),
  );
};

const storageBucket = (
  env: RamoseEnv,
  db: string,
): { bucket: R2Like; calls: BucketCalls } => {
  const recorded = recordingBucket(env.STORE);
  return {
    bucket: prefixedBucket(recorded.bucket, dbPrefix(db)),
    calls: recorded.calls,
  };
};

const rowsOf = (value: unknown): number => {
  if (value === undefined) return DEFAULT_ROWS;
  if (!Number.isSafeInteger(value) || Number(value) < 10 || Number(value) > 5_000) {
    throw new BadRequest({ message: "storage rows must be an integer from 10 through 5000" });
  }
  return Number(value);
};

const seed = async (env: RamoseEnv, db: string, rows: number) => {
  const recorded = storageBucket(env, db);
  const store = new R2NodeStore(recorded.bucket, { codec: gzipCodec });
  const datoms = dataset(db, rows);
  const schema = Schema.bootstrap().apply(datoms);
  const roots = await buildRoots(store, schema, bootstrapDatoms().concat(datoms), {
    leafSize: 64,
    fanout: 8,
  });
  const rec = rootsToRecord(roots, {
    log_watermark: 3,
    next_eid: FIRST_USER_EID + 100 + rows,
    codec: gzipCodec.name,
  });
  await publishRoot(recorded.bucket, rec);
  const depth = Math.max(
    ...(await Promise.all(
      [roots.eavt, roots.aevt, roots.avet, roots.vaet].map((root) =>
        treeDepth(store, root),
      ),
    )),
  );
  const page = await recorded.bucket.list({ prefix: "" });
  if (page.truncated) throw new Internal({ message: "storage test seed exceeded one R2 page" });
  return {
    rec,
    depth,
    expectedRows: Math.floor((rows + 6) / 10),
    probeKey: objectKey(rec.eavt.kind, rec.eavt.hash),
    objectKeys: page.objects.map((object) => object.key),
    rawCalls: recorded.calls,
  };
};

const executeQuery = async (
  store: R2NodeStore,
  rec: RootRecord,
  db: string,
): Promise<number> => ((await query(await dbAt(store, rec), queryText(db))) as unknown[][]).length;

const exerciseTiers = async (env: RamoseEnv, db: string, rows: number): Promise<Response> => {
  const seeded = await seed(env, db, rows);
  const cache = workerCache();
  const nodeKeys = seeded.objectKeys.filter((key) => key.startsWith("seg/") || key.startsWith("n/"));
  await clearCacheObjects(cache, nodeKeys);

  const coldBucket = storageBucket(env, db);
  const coldCache = recordingCache(cacheApiTier(cache));
  const coldStore = new R2NodeStore(coldBucket.bucket, {
    codec: gzipCodec,
    cache: coldCache.tier,
  });
  const coldRows = await executeQuery(coldStore, seeded.rec, db);
  await coldCache.settle();
  const coldGets = coldBucket.calls.get.filter(
    (key) => key.startsWith(`${dbPrefix(db)}seg/`) || key.startsWith(`${dbPrefix(db)}n/`),
  );

  const beforeReuse = snapshotStats(coldStore);
  const reuseRows = await executeQuery(coldStore, seeded.rec, db);
  const reuse = statsDelta(coldStore.stats, beforeReuse);

  const warmBucket = storageBucket(env, db);
  const warmCache = recordingCache(cacheApiTier(cache));
  const warmStore = new R2NodeStore(warmBucket.bucket, {
    codec: gzipCodec,
    cache: warmCache.tier,
  });
  const warmRows = await executeQuery(warmStore, seeded.rec, db);
  await warmCache.settle();

  const cachedKeys = [...new Set(coldCache.calls.put)];
  await corruptCacheObjects(cache, cachedKeys);
  const fallbackBucket = storageBucket(env, db);
  const fallbackCache = recordingCache(cacheApiTier(cache));
  const fallbackStore = new R2NodeStore(fallbackBucket.bucket, {
    codec: gzipCodec,
    cache: fallbackCache.tier,
  });
  const fallbackRows = await executeQuery(fallbackStore, seeded.rec, db);
  await fallbackCache.settle();

  return json({
    ok: true,
    expectedRows: seeded.expectedRows,
    depth: seeded.depth,
    seed: {
      record: seeded.rec,
      objectKeys: seeded.objectKeys,
      rawCalls: seeded.rawCalls,
    },
    cold: {
      rows: coldRows,
      stats: coldStore.stats,
      gets: coldGets,
      cache: coldCache.calls,
    },
    reuse: { rows: reuseRows, stats: reuse },
    warm: {
      rows: warmRows,
      stats: warmStore.stats,
      gets: warmBucket.calls.get,
      cache: warmCache.calls,
    },
    fallback: {
      rows: fallbackRows,
      stats: fallbackStore.stats,
      gets: fallbackBucket.calls.get,
      cache: fallbackCache.calls,
      corruptedKeys: cachedKeys,
    },
  });
};

const exerciseDedupe = async (env: RamoseEnv, db: string): Promise<Response> => {
  const recorded = storageBucket(env, db);
  const store = new R2NodeStore(recorded.bucket, {
    codec: gzipCodec,
    headBeforePut: true,
  });
  const first = await Connection.create({ store });
  const second = await Connection.create({ store });
  const before = await recorded.bucket.list({ prefix: "seg/" });
  if (before.truncated) throw new Internal({ message: "storage dedupe exceeded one R2 page" });

  const unconditional = new R2NodeStore(recorded.bucket, { codec: gzipCodec });
  await Connection.create({ store: unconditional });
  const after = await recorded.bucket.list({ prefix: "seg/" });
  if (after.truncated) throw new Internal({ message: "storage dedupe exceeded one R2 page" });

  return json({
    ok: true,
    sameRoot: first.currentRoots.eavt.hash === second.currentRoots.eavt.hash,
    skippedPuts: store.stats.r2PutSkipped,
    beforeKeys: before.objects.map((object) => object.key),
    afterKeys: after.objects.map((object) => object.key),
    unconditionalPuts: unconditional.stats.r2Puts,
    rawCalls: recorded.calls,
  });
};

const coldRead = async (env: RamoseEnv, db: string): Promise<Response> => {
  const recorded = storageBucket(env, db);
  const rec = await readCurrentRoot(recorded.bucket);
  if (rec === null) throw new BadRequest({ message: "storage database has no current root" });
  const store = new R2NodeStore(recorded.bucket, { codec: gzipCodec });
  const rows = await executeQuery(store, rec, db);
  return json({ ok: true, rows, stats: store.stats, rawCalls: recorded.calls });
};

export const handleStorageTestAdmin = async (
  request: Request,
  env: RamoseEnv,
  db: string,
): Promise<Response> => {
  const body = (await request.json()) as { action?: unknown; rows?: unknown };
  const action = typeof body.action === "string" ? body.action : "";
  if (action === "tiers") return exerciseTiers(env, db, rowsOf(body.rows));
  if (action === "dedupe") return exerciseDedupe(env, db);
  if (action === "seed") {
    const seeded = await seed(env, db, rowsOf(body.rows));
    return json({ ok: true, ...seeded });
  }
  if (action === "cold-read") return coldRead(env, db);
  throw new BadRequest({ message: "storage action must be tiers|dedupe|seed|cold-read" });
};
