/**
 * Test-only admin routes under `/__test__/*` (issue #390).
 *
 * Reachable only from the explicit source-only testing assembly, then absent
 * or 404 unless its non-production flag and private capability agree. Every
 * path forwards to the real R2 bucket, Transactor DO, or Replica DO. Nothing
 * here invents a successful transact, query, or socket frame.
 */

import * as Effect from "effect/Effect";
import {
  makeEntityIdScope,
  openEntityId,
  sealEntityId,
  sealingKeyOf,
  type EntityIdScope,
} from "../internal/replication/index.ts";
import {
  callerFromVerified,
  DatabaseId,
} from "../internal/authorization/index.ts";
import { authenticateRequest } from "./admit.ts";
import { JwtVerifier, fromEnv } from "./jwt.ts";
import { dbPrefix, prefixedBucket } from "../internal/storage/index.ts";
import {
  armCheckpoint,
  checkpointStatus,
  enableTestHooks,
  isCheckpointReleaseDelay,
  MAX_CHECKPOINT_RELEASE_DELAY_MS,
  releaseCheckpoint,
  type CheckpointScope,
} from "../internal/test-hooks.ts";
import { internalHeaders } from "../internal/transactor/internal.ts";
import type { RamoseEnv } from "../RamoseEnv.ts";
import { TEST_SESSION_TOKEN_HEADER } from "./session.ts";
import { BadRequest, Internal, NotFound, UpstreamError } from "./errors.ts";
import {
  basisHeaders,
  type BasisFetchOptions,
  coloHeader,
  fetchBasisWithStats,
  invalidateBasis,
  nearestReplica,
  replicationRevisionStoreId,
} from "./peer.ts";
import { handleStorageTestAdmin } from "./storage-test-admin.ts";
import {
  clearServerIdentityRootCache,
  serverIdentityRoot,
  serverIdentityRootId,
} from "./server-identity.ts";

const json = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const TEST_PREFIX = "/__test__/db/";

export const parseTestAdminPath = (
  pathname: string,
): { db: string; rest: string } | undefined => {
  if (!pathname.startsWith(TEST_PREFIX)) return undefined;
  const tail = pathname.slice(TEST_PREFIX.length);
  const slash = tail.indexOf("/");
  if (slash <= 0) return undefined;
  const db = decodeURIComponent(tail.slice(0, slash));
  const rest = tail.slice(slash);
  return { db, rest };
};

const bytesOf = (bodyBase64: string | undefined): Uint8Array => {
  if (bodyBase64 === undefined || bodyBase64.length === 0) return new Uint8Array();
  return Uint8Array.from(atob(bodyBase64), (c) => c.charCodeAt(0));
};

const b64Of = (bytes: ArrayBuffer): string => {
  const u8 = new Uint8Array(bytes);
  let s = "";
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s);
};

const handleR2 = async (request: Request, env: RamoseEnv, db: string): Promise<Response> => {
  const body = (await request.json()) as {
    action?: unknown;
    key?: unknown;
    bodyBase64?: unknown;
    prefix?: unknown;
  };
  const action = typeof body.action === "string" ? body.action : "";
  const key = typeof body.key === "string" ? body.key : "";
  const bucket = prefixedBucket(env.STORE, dbPrefix(db));
  if (action === "put") {
    if (key.length === 0) throw new BadRequest({ message: "r2 put needs key" });
    await bucket.put(key, bytesOf(typeof body.bodyBase64 === "string" ? body.bodyBase64 : undefined));
    return json({ ok: true, key });
  }
  if (action === "get") {
    if (key.length === 0) throw new BadRequest({ message: "r2 get needs key" });
    const obj = await bucket.get(key);
    if (obj === null) return json({ ok: true, key, found: false });
    return json({ ok: true, key, found: true, bodyBase64: b64Of(await obj.arrayBuffer()) });
  }
  if (action === "head") {
    if (key.length === 0) throw new BadRequest({ message: "r2 head needs key" });
    const obj = await bucket.head(key);
    return json({ ok: true, key, found: obj !== null });
  }
  if (action === "delete") {
    if (key.length === 0) throw new BadRequest({ message: "r2 delete needs key" });
    await bucket.delete(key);
    return json({ ok: true, key });
  }
  if (action === "list") {
    const prefix = typeof body.prefix === "string" ? body.prefix : "";
    const page = await bucket.list({ prefix });
    return json({ ok: true, objects: page.objects, truncated: page.truncated });
  }
  throw new BadRequest({ message: "r2 action must be put|get|head|delete|list" });
};

const handleCheckpointLocal = (body: {
  action?: unknown;
  name?: unknown;
  error?: unknown;
  releaseAfterMs?: unknown;
}): Response => {
  const action = typeof body.action === "string" ? body.action : "";
  const name = typeof body.name === "string" ? body.name : "";
  if (action === "status") return json({ ok: true, checkpoints: checkpointStatus() });
  if (name.length === 0) throw new BadRequest({ message: "checkpoint needs name" });
  if (action === "arm-wait") {
    const releaseAfterMs = body.releaseAfterMs;
    if (
      releaseAfterMs !== undefined &&
      !isCheckpointReleaseDelay(releaseAfterMs)
    ) {
      throw new BadRequest({
        message: `checkpoint releaseAfterMs must be between 0 and ${MAX_CHECKPOINT_RELEASE_DELAY_MS}`,
      });
    }
    armCheckpoint(name, "wait", undefined, releaseAfterMs as number | undefined);
    return json({ ok: true, name, action: "wait" });
  }
  if (action === "arm-throw") {
    armCheckpoint(name, "throw", typeof body.error === "string" ? body.error : undefined);
    return json({ ok: true, name, action: "throw" });
  }
  if (action === "release") {
    releaseCheckpoint(name);
    return json({ ok: true, name, action: "release" });
  }
  throw new BadRequest({ message: "checkpoint action must be arm-wait|arm-throw|release|status" });
};

const transactorUrl = (db: string, path: string): string =>
  `https://transactor${path}${path.includes("?") ? "&" : "?"}db=${encodeURIComponent(db)}`;

const forwardTransactorSubscription = (
  request: Request,
  env: RamoseEnv,
  db: string,
  from: number,
): Promise<Response> =>
  env.TRANSACTOR.get(env.TRANSACTOR.idFromName(db)).fetch(
    transactorUrl(db, `/subscribe?from=${from}`),
    {
      headers: {
        Upgrade: "websocket",
        ...coloHeader(request),
        ...internalHeaders(env),
      },
    },
  );

/** Replica catch-up fence. Only forwarded when the caller set it. */
const minTHeader = (request: Request): Record<string, string> => {
  const minT = request.headers.get("x-ramose-min-t");
  return minT === null || minT.length === 0 ? {} : { "x-ramose-min-t": minT };
};

const testMinimumBasis = (request: Request): number | undefined => {
  const raw = request.headers.get("x-ramose-min-t");
  if (raw === null || raw.length === 0) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
};

const TEST_REPLICA_HINTS = new Set([
  "wnam",
  "enam",
  "sam",
  "weur",
  "eeur",
  "apac",
  "oc",
  "afr",
  "me",
]);

const testBasisOptions = (request: Request): BasisFetchOptions => {
  const useCacheHeader = request.headers.get("x-ramose-cache-basis");
  const modeHeader = request.headers.get("x-ramose-cache-mode");
  const hintHeader = request.headers.get("x-ramose-replica-hint");
  return {
    minimumBasis: testMinimumBasis(request),
    ...(useCacheHeader === "0"
      ? { useCache: false }
      : useCacheHeader === "1"
        ? { useCache: true }
        : {}),
    ...(modeHeader === "peer" || modeHeader === "ttl"
      ? { cacheMode: modeHeader }
      : {}),
    ...(hintHeader !== null && TEST_REPLICA_HINTS.has(hintHeader)
      ? { replicaHint: hintHeader }
      : {}),
  };
};

const forward = async (
  request: Request,
  env: RamoseEnv,
  db: string,
  scope: CheckpointScope,
  path: string,
  body: string,
  opts: { readonly passThrough?: boolean } = {},
): Promise<Response> => {
  const headers = {
    "content-type": "application/json",
    ...coloHeader(request),
    ...internalHeaders(env),
    ...minTHeader(request),
  };
  try {
    const res =
      scope === "replica"
        ? await nearestReplica(env, db, request).fetch(`https://replica${path}?db=${encodeURIComponent(db)}`, {
            method: "POST",
            headers,
            body,
          })
        : await env.TRANSACTOR.get(env.TRANSACTOR.idFromName(db)).fetch(transactorUrl(db, path), {
            method: "POST",
            headers,
            body,
          });
    // transact/query must surface the real DO status (409 cas-conflict, 400
    // tx/invalid, 503 TransactorDead). checkpoint/abort stay fail-closed.
    if (!res.ok && opts.passThrough !== true) {
      throw new UpstreamError({ status: res.status, body: await res.text() });
    }
    return new Response(res.body, {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    // `ctx.abort` discards the isolate; the stub fetch rejects instead of
    // returning the ack. The instance is gone — that is the success path
    // for abort only. transact/query after `die()` must not invent 200.
    if (path === "/admin/test/abort") {
      return json({ ok: true, aborted: true });
    }
    throw err instanceof Error ? err : new Error(String(err));
  }
};

const entityIdScopeOfBody = (value: unknown): EntityIdScope => {
  const record = typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
  const { server, principal, database } = record;
  if (
    typeof server !== "string" ||
    typeof principal !== "string" ||
    typeof database !== "string"
  ) {
    throw new BadRequest({
      message: "entity-id scope needs server, principal and database",
    });
  }
  return { server, principal, database };
};

/**
 * Real durable identity/sealing root, read through the same internal boundary
 * production uses. Key material never crosses this route: only the public key
 * id, and one boolean proving the root is not the rotating Worker→DO
 * capability.
 *
 * The `seal-entity-id` / `open-entity-id` actions run the real #475 E0 codec
 * against that live record inside workerd — no key, eid, or scope is invented
 * here.
 */
const handleServerIdentity = async (
  request: Request,
  env: RamoseEnv,
  db: string,
): Promise<Response> => {
  const body = (await request.json()) as {
    action?: unknown;
    eid?: unknown;
    token?: unknown;
    scope?: unknown;
    bearer?: unknown;
  };
  if (body.action === "forget-isolate-cache") {
    clearServerIdentityRootCache();
    return json({ ok: true, forgotten: true });
  }
  if (
    body.action !== "probe" &&
    body.action !== "seal-entity-id" &&
    body.action !== "open-entity-id" &&
    body.action !== "invocation-entity-id-scope"
  ) {
    throw new BadRequest({
      message:
        "server-identity action must be probe|forget-isolate-cache|seal-entity-id|open-entity-id|invocation-entity-id-scope",
    });
  }
  const root = await serverIdentityRoot(env);
  if (body.action === "invocation-entity-id-scope") {
    // The exact scope the `/op` boundary derives, computed by the same code
    // from the same three inputs: the request origin, the *really verified*
    // caller behind this bearer, and this database. Nothing is invented — the
    // real JWT verifier runs, and a scope that disagreed with the one an
    // invocation was sealed under simply fails to open its handles.
    if (typeof body.bearer !== "string" || body.bearer.length === 0) {
      throw new BadRequest({
        message: "invocation-entity-id-scope needs a bearer",
      });
    }
    const verified = await Effect.runPromise(
      authenticateRequest(
        new Request(request.url, {
          headers: { authorization: `Bearer ${body.bearer}` },
        }),
      ).pipe(Effect.provideService(JwtVerifier, fromEnv(env))),
    );
    return json({
      ok: true,
      keyId: root.keyId,
      scope: await makeEntityIdScope(sealingKeyOf(root), {
        origin: new URL(request.url).origin,
        caller: callerFromVerified(verified),
        database: DatabaseId.make(db),
      }),
    });
  }
  if (body.action === "seal-entity-id") {
    if (typeof body.eid !== "number") {
      throw new BadRequest({ message: "seal-entity-id needs a numeric eid" });
    }
    return json({
      ok: true,
      keyId: root.keyId,
      token: await sealEntityId(
        sealingKeyOf(root),
        entityIdScopeOfBody(body.scope),
        body.eid,
      ),
    });
  }
  if (body.action === "open-entity-id") {
    if (typeof body.token !== "string") {
      throw new BadRequest({ message: "open-entity-id needs a token" });
    }
    return json({
      ok: true,
      keyId: root.keyId,
      resolution: await openEntityId(
        sealingKeyOf(root),
        entityIdScopeOfBody(body.scope),
        body.token,
      ),
    });
  }
  return json({
    ok: true,
    version: root.version,
    keyId: root.keyId,
    createdAt: root.createdAt,
    objectId: serverIdentityRootId(env).toString(),
    // Separation of the two roles, asserted without revealing either secret.
    isInternalSecret: root.key === env.RAMOSE_INTERNAL_SECRET,
  });
};

/** Direct access to one real replication-revision store, by explicit key id. */
const handleReplicationRevision = async (
  request: Request,
  env: RamoseEnv,
  db: string,
): Promise<Response> => {
  const body = (await request.json()) as {
    action?: unknown;
    revision?: unknown;
    binding?: unknown;
    basisT?: unknown;
    keyId?: unknown;
  };
  if (
    typeof body.binding !== "string" ||
    typeof body.keyId !== "string" ||
    typeof body.revision !== "string"
  ) {
    throw new BadRequest({
      message: "replication-revision needs revision, binding and keyId",
    });
  }
  const response = await env.REPLICA.get(
    replicationRevisionStoreId(env, db, body.binding),
  ).fetch(`https://replica/replication/revision?db=${encodeURIComponent(db)}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...internalHeaders(env) },
    body: JSON.stringify(body),
  });
  return new Response(response.body, {
    status: response.status,
    headers: { "content-type": "application/json" },
  });
};

/** Worker entry for `/__test__/db/:name/...`. Caller already checked the env gate. */
export const handleTestAdmin = async (
  request: Request,
  env: RamoseEnv,
  url: URL,
): Promise<Response> => {
  enableTestHooks();
  const parsed = parseTestAdminPath(url.pathname);
  if (parsed === undefined) throw new NotFound({ message: "unknown test admin path" });
  const { db, rest } = parsed;
  if (rest === "/subscribe") {
    if (request.method !== "GET") {
      throw new BadRequest({ message: "test transactor subscription is GET" });
    }
    const from = Number(url.searchParams.get("from") ?? "0");
    if (!Number.isSafeInteger(from) || from < 0) {
      throw new BadRequest({ message: "test transactor subscription needs a non-negative integer from" });
    }
    return forwardTransactorSubscription(request, env, db, from);
  }
  if (rest === "/watch") {
    if (request.method !== "GET") throw new BadRequest({ message: "test watch is GET" });
    const expectedDeployment = env.CF_VERSION_METADATA?.id;
    if (typeof expectedDeployment !== "string" || expectedDeployment.length === 0) {
      throw new Internal({ message: "missing deployment metadata" });
    }
    const health = new URL("/health", request.url);
    if (health.protocol === "ws:") health.protocol = "http:";
    if (health.protocol === "wss:") health.protocol = "https:";
    return nearestReplica(env, db, request).fetch(`https://replica/watch?db=${encodeURIComponent(db)}`, {
      headers: {
        Upgrade: "websocket",
        ...coloHeader(request),
        ...internalHeaders(env),
        "x-ramose-live-deployment": expectedDeployment,
        "x-ramose-live-health": health.href,
      },
    });
  }
  if (rest === "/session") {
    if (request.method !== "GET") throw new BadRequest({ message: "test session is GET" });
    const token = url.searchParams.get("token");
    const headers = {
      Upgrade: "websocket",
      ...coloHeader(request),
      ...internalHeaders(env),
      ...(token === null ? {} : { [TEST_SESSION_TOKEN_HEADER]: token }),
    };
    return nearestReplica(env, db, request).fetch(
      `https://replica/session?db=${encodeURIComponent(db)}`,
      { headers },
    );
  }
  if (request.method !== "POST") throw new BadRequest({ message: "test admin is POST" });
  if (rest === "/r2") return handleR2(request, env, db);
  if (rest === "/server-identity") return handleServerIdentity(request, env, db);
  if (rest === "/replication-revision") {
    return handleReplicationRevision(request, env, db);
  }
  if (rest === "/storage") return handleStorageTestAdmin(request, env, db);
  if (rest === "/basis") {
    const body = (await request.json()) as { action?: unknown };
    if (body.action === "invalidate") {
      invalidateBasis(db);
      return json({ ok: true, db, invalidated: true });
    }
    if (body.action !== "fetch") {
      throw new BadRequest({ message: "basis action must be fetch|invalidate" });
    }
    const options = testBasisOptions(request);
    const fetched = await fetchBasisWithStats(env, db, request, options);
    return json(fetched, 200, basisHeaders(request, env, fetched, options));
  }
  if (rest === "/checkpoint") {
    const raw = await request.text();
    const body = raw.length === 0 ? {} : (JSON.parse(raw) as {
      scope?: unknown;
      action?: unknown;
      name?: unknown;
      error?: unknown;
      releaseAfterMs?: unknown;
    });
    const scope: CheckpointScope =
      body.scope === "transactor" || body.scope === "replica" || body.scope === "worker"
        ? body.scope
        : "worker";
    if (scope === "worker") return handleCheckpointLocal(body);
    return forward(request, env, db, scope, "/admin/test/checkpoint", raw.length === 0 ? "{}" : raw);
  }
  if (rest === "/abort") {
    const body = (await request.json()) as { target?: unknown };
    const target = body.target === "replica" ? "replica" : "transactor";
    return forward(request, env, db, target, "/admin/test/abort", "{}");
  }
  if (rest === "/reconnect") {
    return forward(request, env, db, "replica", "/admin/reconnect", "{}", {
      passThrough: true,
    });
  }
  if (rest === "/sessions") {
    return forward(request, env, db, "replica", "/admin/test/sessions", "{}", {
      passThrough: true,
    });
  }
  if (rest === "/index") {
    return forward(request, env, db, "transactor", "/admin/index", "{}", {
      passThrough: true,
    });
  }
  if (rest === "/info") {
    return forward(request, env, db, "transactor", "/info", "{}", {
      passThrough: true,
    });
  }
  if (rest === "/operation-receipts") {
    return forward(
      request,
      env,
      db,
      "transactor",
      "/admin/test/operation-receipts",
      "{}",
      { passThrough: true },
    );
  }
  if (rest === "/log") {
    const body = (await request.json()) as { from?: unknown; to?: unknown };
    const from = body.from === undefined ? 0 : body.from;
    const to = body.to === undefined ? Number.MAX_SAFE_INTEGER : body.to;
    if (
      typeof from !== "number" || !Number.isSafeInteger(from) || from < 0 ||
      typeof to !== "number" || !Number.isSafeInteger(to) || to < from
    ) {
      throw new BadRequest({ message: "test transactor log needs integer 0 <= from <= to" });
    }
    return forward(
      request,
      env,
      db,
      "transactor",
      `/log?from=${from}&to=${to}`,
      "{}",
      { passThrough: true },
    );
  }
  if (rest === "/transact") {
    return forward(request, env, db, "transactor", "/transact", await request.text(), {
      passThrough: true,
    });
  }
  if (rest === "/query") {
    return forward(request, env, db, "replica", "/query", await request.text(), {
      passThrough: true,
    });
  }
  throw new NotFound({ message: "unknown test admin path" });
};

export const asTestAdminError = (err: unknown): BadRequest | NotFound | UpstreamError | Internal => {
  if (err instanceof BadRequest || err instanceof NotFound || err instanceof UpstreamError || err instanceof Internal) {
    return err;
  }
  return new Internal({ message: err instanceof Error ? err.message : String(err) });
};

export type { CheckpointScope };
