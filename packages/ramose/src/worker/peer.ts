import { R2NodeStore, cacheApiTier, dbPrefix, prefixedBucket } from "../internal/storage/index.ts";
import { type RamoseEnv, internalHeaders } from "../internal/transactor/index.ts";
import type { Basis } from "../internal/replica/index.ts";
import type { LiveBasisEvent } from "../internal/authorization/live.ts";
import { Unauthorized } from "../db/Errors.ts";
import {
  SERVER_IDENTITY_INCOMPATIBLE,
  ServerIdentityIncompatible,
} from "../internal/replication/server-identity.ts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { UpstreamError } from "./errors.ts";

const sources = new Map<string, R2NodeStore>();
const MAX_SOURCES = 64;

export function segmentSource(env: RamoseEnv, db: string): R2NodeStore {
  let source = sources.get(db);
  if (!source) {
    if (sources.size >= MAX_SOURCES) sources.delete(sources.keys().next().value!);
    const cache = (globalThis as any).caches?.default;
    source = new R2NodeStore(prefixedBucket(env.STORE, dbPrefix(db)), { maxNodes: 2048, ...(cache ? { cache: cacheApiTier(cache) } : {}) });
    sources.set(db, source);
  }
  return source;
}

export function clearSegmentSources(): void {
  sources.clear();
}

export function replicaId(env: RamoseEnv, db: string, region: string, shards = 1, hint: string | undefined = hintFor(region)): DurableObjectId {
  const shard = shards > 1 ? fnv1a(`${db}|${region}`) % shards : 0;
  return env.REPLICA.idFromName(hint ? `${db}|${region}|${hint}|${shard}` : `${db}|${region}|${shard}`);
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export function regionOf(request: Request): string {
  const cf = (request as any).cf as { continent?: string; colo?: string } | undefined;
  return cf?.continent ?? "global";
}

export type CacheMode = "ttl" | "peer";

const HINTS = new Set(["wnam", "enam", "sam", "weur", "eeur", "apac", "oc", "afr", "me"]);

const COLO_HINT: Record<string, string> = {
  IAD: "enam", EWR: "enam", ATL: "enam", ORD: "enam", MIA: "enam", BOS: "enam", YYZ: "enam", YUL: "enam", DFW: "enam", IAH: "enam", MSP: "enam", DTW: "enam", CLT: "enam", PHL: "enam", PIT: "enam", BNA: "enam", MCI: "enam", STL: "enam", TPA: "enam", RIC: "enam", BUF: "enam", CMH: "enam", IND: "enam", MEM: "enam", JAX: "enam", MCO: "enam", RDU: "enam", CLE: "enam", MKE: "enam", OMA: "enam", OKC: "enam", MSY: "enam", SAT: "enam", AUS: "enam", YOW: "enam", YHZ: "enam",
  SJC: "wnam", LAX: "wnam", SEA: "wnam", SFO: "wnam", PDX: "wnam", DEN: "wnam", PHX: "wnam", LAS: "wnam", SLC: "wnam", SAN: "wnam", SMF: "wnam", YVR: "wnam", YYC: "wnam", ABQ: "wnam", HNL: "wnam", ANC: "wnam", BOI: "wnam", ELP: "wnam", TUS: "wnam", GEG: "wnam", RNO: "wnam", YEG: "wnam",
};

export function coloHint(colo: string | undefined): string | undefined {
  return colo ? COLO_HINT[colo.toUpperCase()] : undefined;
}

export function hintOf(request: Request, env?: Pick<RamoseEnv, "RAMOSE_REPLICA_HINT">): string | undefined {
  const cf = (request as any).cf as { colo?: string } | undefined;
  const pick = env?.RAMOSE_REPLICA_HINT ?? "auto";
  if (pick === "auto") return coloHint(cf?.colo) ?? hintFor(regionOf(request));
  if (pick && HINTS.has(pick)) return pick;
  return hintFor(regionOf(request));
}

export function coloOf(request: Request): string {
  return String((request as any).cf?.colo ?? "unknown");
}
export function coloHeader(request: Request): Record<string, string> {
  return { "x-ramose-colo": coloOf(request) };
}

export function nearestReplica(
  env: RamoseEnv,
  db: string,
  request: Request,
  trustedHint?: string,
): DurableObjectStub {
  const region = regionOf(request);
  const hint = trustedHint ?? hintOf(request, env);
  return env.REPLICA.get(replicaId(env, db, region, 1, hint), { locationHint: hint } as any);
}

export const watchBasisChanges = (
  env: RamoseEnv,
  db: string,
  request: Request,
): {
  readonly changes: Stream.Stream<LiveBasisEvent, Unauthorized>;
  readonly currentBasis: () => Basis | undefined;
  readonly failed: Promise<void>;
} => {
  let currentBasis: Basis | undefined;
  let failWatch!: () => void;
  const failed = new Promise<void>((resolve) => {
    failWatch = resolve;
  });
  const changes = Stream.callback<LiveBasisEvent, Unauthorized>((out) =>
    Effect.gen(function* () {
      const expectedDeployment = env.CF_VERSION_METADATA?.id;
      if (typeof expectedDeployment !== "string" || expectedDeployment.length === 0) {
        return yield* new Unauthorized({});
      }
      const health = new URL("/health", request.url);
      const stub = nearestReplica(env, db, request);
      const response = yield* Effect.tryPromise({
        try: () => stub.fetch(`https://replica/watch?db=${encodeURIComponent(db)}`, {
          headers: {
            Upgrade: "websocket",
            ...coloHeader(request),
            ...internalHeaders(env),
            "x-ramose-live-deployment": expectedDeployment,
            "x-ramose-live-health": health.href,
          },
        }),
        catch: () => new Unauthorized({}),
      });
      const ws = response.webSocket;
      if (response.status !== 101 || ws === null) {
        return yield* new Unauthorized({});
      }
      const fail = () => {
        failWatch();
        Queue.failCauseUnsafe(out, Cause.fail(new Unauthorized({})));
        try {
          ws.close(1011, "live watch failed");
        } catch {
        }
      };
      ws.addEventListener("message", (event) => {
        try {
          const frame = JSON.parse(String(event.data)) as {
            kind?: unknown;
            t?: unknown;
            basis?: Partial<Basis>;
          };
          const basis = frame.basis;
          if (
            !Number.isSafeInteger(frame.t) ||
            basis?.v !== 1 ||
            basis.db !== db ||
            basis.t !== frame.t ||
            basis.root === undefined ||
            !Array.isArray(basis.novelty)
          ) return fail();
          currentBasis = basis as Basis;
          if (frame.kind === "ready") Queue.offerUnsafe(out, "ready");
          else if (frame.kind === "basis") Queue.offerUnsafe(out, "change");
          else fail();
        } catch {
          fail();
        }
      });
      ws.addEventListener("close", fail);
      ws.addEventListener("error", fail);
      ws.accept();
      yield* Effect.addFinalizer(() => Effect.sync(() => {
        try {
          ws.close(1000, "live response closed");
        } catch {
        }
      }));
    }),
    { bufferSize: 1, strategy: "sliding" },
  );
  return { changes, currentBasis: () => currentBasis, failed };
};

export type ReplicationRevisionRecord = {
  readonly revision: string;
  readonly scope: string;
  readonly basisT: number;
  readonly keyId: string;
};

export type ReplicationRevisionIssuance =
  | { readonly type: "issued"; readonly ordinal: number }
  | { readonly type: "refused" };

const rejectQuarantined = async (
  response: Response,
  keyId: string,
): Promise<void> => {
  if (response.status !== 409) return;
  const body = (await response.clone().json().catch(() => undefined)) as {
    readonly error?: unknown;
    readonly persisted?: unknown;
  } | undefined;
  if (body?.error !== SERVER_IDENTITY_INCOMPATIBLE) return;
  throw new ServerIdentityIncompatible({
    persisted: typeof body.persisted === "string" ? body.persisted : "unknown",
    current: keyId,
  });
};

export const replicationRevisionStoreId = (
  env: Pick<RamoseEnv, "REPLICA">,
  database: string,
  scope: string,
): DurableObjectId => env.REPLICA.idFromName(
  `ramose-replication-revisions-v2|${database}|${scope}`,
);

const replicationRevisionStore = (
  env: RamoseEnv,
  database: string,
  scope: string,
): DurableObjectStub => env.REPLICA.get(
  replicationRevisionStoreId(env, database, scope),
);

export const rememberReplicationRevision = async (
  env: RamoseEnv,
  database: string,
  record: ReplicationRevisionRecord,
): Promise<ReplicationRevisionIssuance> => {
  const response = await replicationRevisionStore(
    env,
    database,
    record.scope,
  ).fetch(
    `https://replica/replication/revision?db=${encodeURIComponent(database)}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...internalHeaders(env),
      },
      body: JSON.stringify({ action: "remember", ...record }),
    },
  );
  await rejectQuarantined(response, record.keyId);
  if (!response.ok) throw new UpstreamError({
    status: response.status,
    body: await response.text(),
  });
  const body = (await response.json()) as { readonly ordinal?: unknown };
  return Number.isSafeInteger(body.ordinal) && (body.ordinal as number) > 0
    ? Object.freeze({ type: "issued" as const, ordinal: body.ordinal as number })
    : Object.freeze({ type: "refused" as const });
};

export const resolveReplicationRevision = async (
  env: RamoseEnv,
  database: string,
  revision: string,
  scope: string,
  keyId: string,
): Promise<number | undefined> => {
  const response = await replicationRevisionStore(
    env,
    database,
    scope,
  ).fetch(
    `https://replica/replication/revision?db=${encodeURIComponent(database)}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...internalHeaders(env),
      },
      body: JSON.stringify({ action: "resolve", revision, scope, keyId }),
    },
  );
  await rejectQuarantined(response, keyId);
  if (!response.ok) throw new UpstreamError({
    status: response.status,
    body: await response.text(),
  });
  const body = (await response.json()) as {
    readonly found?: unknown;
    readonly basisT?: unknown;
  };
  return body.found === true && Number.isSafeInteger(body.basisT) &&
      (body.basisT as number) >= 0
    ? body.basisT as number
    : undefined;
};

export const resolveSettledThrough = async (
  env: RamoseEnv,
  database: string,
  principalId: string,
  basisT: number,
): Promise<number> => {
  const response = await env.TRANSACTOR.get(env.TRANSACTOR.idFromName(database))
    .fetch(`https://transactor/settled?db=${encodeURIComponent(database)}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...internalHeaders(env),
      },
      body: JSON.stringify({ principalId, basisT }),
    });
  if (!response.ok) throw new UpstreamError({
    status: response.status,
    body: await response.text(),
  });
  const body = (await response.json()) as { readonly settled?: unknown };
  if (!Number.isSafeInteger(body.settled) || (body.settled as number) < 0) {
    throw new UpstreamError({
      status: 502,
      body: JSON.stringify({ error: "transactor returned an invalid settlement" }),
    });
  }
  return body.settled as number;
};

export function wantsBasisCache(_request: Request, env?: Pick<RamoseEnv, "RAMOSE_CACHE_BASIS">): boolean {
  const h = env?.RAMOSE_CACHE_BASIS ?? "1";
  return h !== "0";
}

export function cacheModeOf(_request: Request, env?: Pick<RamoseEnv, "RAMOSE_CACHE_MODE">): CacheMode {
  const h = env?.RAMOSE_CACHE_MODE;
  return h === "peer" ? "peer" : "ttl";
}

const basisCache = new Map<string, { basis: Basis; at: number }>();
export const BASIS_TTL_MS = 5_000;
export const BASIS_SAFETY_TTL_MS = 10 * 60_000;
const MIN_T_RETRIES = 5;
const MIN_T_RETRY_MS = 20;

export type BasisCacheReason = "hit" | "off" | "miss" | "expired" | "min-t";

export const basisCacheDecision = (
  useCache: boolean,
  mode: CacheMode,
  now: number,
  cached: { readonly t: number; readonly at: number } | undefined,
  minT: number | undefined,
): BasisCacheReason => {
  if (!useCache) return "off";
  if (cached === undefined) return "miss";
  const ttl = mode === "peer" ? BASIS_SAFETY_TTL_MS : BASIS_TTL_MS;
  if (now - cached.at >= ttl) return "expired";
  if (minT !== undefined && cached.t < minT) return "min-t";
  return "hit";
};

export const shouldReplaceCachedBasis = (
  cachedT: number | undefined,
  fetchedT: number,
): boolean => cachedT === undefined || cachedT <= fetchedT;

export function invalidateBasis(db: string): void {
  for (const k of basisCache.keys()) if (k.startsWith(`${db}|`)) basisCache.delete(k);
}

export function clearBasisCache(): void {
  basisCache.clear();
}

export interface BasisFetch {
  basis: Basis;
  hit: boolean;
  reason: BasisCacheReason;
  calls: number;
  behind: boolean;
}

export interface BasisFetchOptions {
  readonly bypassCache?: boolean;
  readonly authoritativeFence?: boolean;
  readonly minimumBasis?: number | undefined;
  readonly useCache?: boolean | undefined;
  readonly cacheMode?: CacheMode | undefined;
  readonly replicaHint?: string | undefined;
}

export const basisCacheEnabled = (
  request: Request,
  env?: Pick<RamoseEnv, "RAMOSE_CACHE_BASIS">,
  options: BasisFetchOptions = {},
): boolean =>
  options.bypassCache !== true &&
  (options.useCache ?? wantsBasisCache(request, env));

export const effectiveBasisMinT = (
  clientMinT: number | undefined,
  transactorT: number | undefined,
): number | undefined => {
  if (clientMinT === undefined) return transactorT;
  if (transactorT === undefined) return clientMinT;
  return Math.max(clientMinT, transactorT);
};

const fetchTransactorT = async (env: RamoseEnv, db: string): Promise<number> => {
  const stub = env.TRANSACTOR.get(env.TRANSACTOR.idFromName(db));
  const res = await stub.fetch(
    `https://transactor/info?db=${encodeURIComponent(db)}`,
    { headers: internalHeaders(env) },
  );
  if (!res.ok) throw new UpstreamError({ status: res.status, body: await res.text() });
  const body = (await res.json()) as { readonly t?: unknown };
  if (!Number.isSafeInteger(body.t) || (body.t as number) < 0) {
    throw new UpstreamError({
      status: 502,
      body: JSON.stringify({ error: "transactor returned an invalid basis" }),
    });
  }
  return body.t as number;
};

export async function fetchBasisWithStats(
  env: RamoseEnv,
  db: string,
  request: Request,
  options: BasisFetchOptions = {},
): Promise<BasisFetch> {
  const useCache = basisCacheEnabled(request, env, options);
  const mode = options.cacheMode ?? cacheModeOf(request, env);
  const transactorT = options.authoritativeFence === true
    ? await fetchTransactorT(env, db)
    : undefined;
  const minT = effectiveBasisMinT(options.minimumBasis, transactorT);
  const hint = options.replicaHint ?? hintOf(request, env);
  const key = `${db}|${hint ?? ""}`;
  const hit = basisCache.get(key);
  const reason = basisCacheDecision(
    useCache,
    mode,
    Date.now(),
    hit === undefined ? undefined : { t: hit.basis.t, at: hit.at },
    minT,
  );
  if (reason === "hit" && hit !== undefined) {
    return { basis: hit.basis, hit: true, reason, calls: 0, behind: false };
  }
  const stub = nearestReplica(env, db, request, hint);
  let calls = 0;
  let basis: Basis;
  for (;;) {
    calls++;
    const res = await stub.fetch(`https://replica/basis?db=${encodeURIComponent(db)}`, {
      headers: {
        ...coloHeader(request),
        ...internalHeaders(env),
        ...(minT === undefined ? {} : { "x-ramose-min-t": String(minT) }),
      },
    });
    if (!res.ok) throw new UpstreamError({ status: res.status, body: await res.text() });
    basis = (await res.json()) as Basis;
    if (minT === undefined || basis.t >= minT || calls > MIN_T_RETRIES) break;
    await new Promise((r) => setTimeout(r, MIN_T_RETRY_MS));
  }
  const behind = minT !== undefined && basis.t < minT;
  if (options.authoritativeFence === true && behind) {
    throw new UpstreamError({
      status: 503,
      body: JSON.stringify({ error: "replica behind authoritative basis" }),
    });
  }
  if (useCache) {
    const cur = basisCache.get(key);
    if (shouldReplaceCachedBasis(cur?.basis.t, basis.t)) {
      basisCache.set(key, { basis, at: Date.now() });
    }
  }
  return { basis, hit: false, reason, calls, behind };
}

export async function fetchBasis(
  env: RamoseEnv,
  db: string,
  request: Request,
  options: BasisFetchOptions = {},
): Promise<Basis> {
  return (await fetchBasisWithStats(env, db, request, options)).basis;
}

export function basisHeaders(
  request: Request,
  env: RamoseEnv,
  f: BasisFetch,
  options: BasisFetchOptions = {},
): Record<string, string> {
  return {
    "x-ramose-basis-t": String(f.basis.t),
    "x-ramose-basis-hit": f.hit ? "1" : "0",
    "x-ramose-basis-reason": f.reason,
    "x-ramose-basis-calls": String(f.calls),
    ...(f.behind ? { "x-ramose-basis-behind": "1" } : {}),
    "x-ramose-replica-hint": options.replicaHint ?? hintOf(request, env) ?? "",
    "x-ramose-cache-basis": (options.useCache ?? wantsBasisCache(request, env)) ? "1" : "0",
    "x-ramose-cache-mode": options.cacheMode ?? cacheModeOf(request, env),
    "x-ramose-colo": String((request as any).cf?.colo ?? ""),
  };
}

export function hintFor(continent: string): string | undefined {
  switch (continent) {
    case "NA": return "wnam";
    case "EU": return "weur";
    case "AS": return "apac";
    case "OC": return "oc";
    case "SA": return "sam";
    case "AF": return "afr";
    default: return undefined;
  }
}
