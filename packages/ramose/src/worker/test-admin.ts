/**
 * Test-only admin routes under `/__test__/*` (issue #390).
 *
 * Absent or 404 unless `RAMOSE_TEST_HOOKS=1` and the stage is not `prod`.
 * Every path forwards to the real R2 bucket, Transactor DO, or Replica DO.
 * Nothing here invents a successful transact, query, or socket frame.
 */

import { dbPrefix, prefixedBucket } from "../internal/storage/index.ts";
import {
  armCheckpoint,
  checkpointStatus,
  enableTestHooks,
  releaseCheckpoint,
  type CheckpointScope,
} from "../internal/test-hooks.ts";
import { internalHeaders } from "../internal/transactor/internal.ts";
import type { RamoseEnv } from "../RamoseEnv.ts";
import { BadRequest, Internal, NotFound, UpstreamError } from "./errors.ts";
import { coloHeader, nearestReplica } from "./peer.ts";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
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
}): Response => {
  const action = typeof body.action === "string" ? body.action : "";
  const name = typeof body.name === "string" ? body.name : "";
  if (action === "status") return json({ ok: true, checkpoints: checkpointStatus() });
  if (name.length === 0) throw new BadRequest({ message: "checkpoint needs name" });
  if (action === "arm-wait") {
    armCheckpoint(name, "wait");
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

/** Replica catch-up fence. Only forwarded when the caller set it. */
const minTHeader = (request: Request): Record<string, string> => {
  const minT = request.headers.get("x-ramose-min-t");
  return minT === null || minT.length === 0 ? {} : { "x-ramose-min-t": minT };
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
  if (request.method !== "POST") throw new BadRequest({ message: "test admin is POST" });
  if (rest === "/r2") return handleR2(request, env, db);
  if (rest === "/checkpoint") {
    const raw = await request.text();
    const body = raw.length === 0 ? {} : (JSON.parse(raw) as { scope?: unknown; action?: unknown; name?: unknown; error?: unknown });
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
