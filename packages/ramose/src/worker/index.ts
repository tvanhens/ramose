/**
 * Ramose peer Worker — the HTTP API and the edge datalog executor.
 *
 * Read-path knobs (per request by header, default by env — see peer.ts):
 * `x-ramose-replica-hint: wnam|enam|…|auto|continent` picks the replica DO placement
 * (hint is part of the DO id; default `auto` = colo→hint); `x-ramose-cache-basis: 0|1`
 * (default 1) reuses an isolate-cached basis instead of calling the replica each read;
 * `x-ramose-cache-mode: ttl|peer` (default ttl = 5 s) picks the cache's consistency story;
 * `x-ramose-min-t: <t>` makes a read refetch if the cached basis is older than t.
 *
 *   GET  /                                  demo app (CRUD + as-of history view)
 *   GET  /health              { ok, service, stage, time, operations: string[] }
 *   POST /db/:name/transact   { tx, clientTxId? }        → { t, txEid, tempids, datoms: WireDatom[], clientTxId? }
 *   POST /db/:name/op         { name, entity?, input, clientOpId } → { t, txEid, tempids, datoms, clientOpId, output }
 *   POST /db/:name/query      { query, inputs?, asOf?, history? }   → { t, result }
 *   POST /db/:name/pull       { eid, pattern, asOf?, history? }     → { t, result }
 *   GET  /db/:name/entity/:eid[?asOf=]                              → { t, entity }
 *   GET  /db/:name/info                                            → { db, t, principal, … } — `t` and `principal` for everyone; transactor/replica internals for admin
 *   GET  /db/:name/session    (Upgrade: websocket)                 → auth + upgrade onto the replica stub (follow lives on the replica)
 *   POST /db/:name/admin/index | /admin/gc                         → indexer controls
 *
 * Reads: basis (root + novelty) from the nearest QueryReplica DO → Db over
 * cached segments → datalog here in the Worker. Writes: forwarded to the
 * Transactor DO. Auth: a bearer token resolved to a `Principal` per request
 * (auth.ts) — a verified JWT under `RAMOSE_POLICY`, else the legacy shared
 * `RAMOSE_TOKEN`; the policy filters reads and checks writes.
 *
 * The request is one Effect: routing failures are `Data.TaggedError`s
 * (errors.ts) mapped back to responses with `Effect.catchTags`, and every
 * request emits one Analytics Engine point through the `Analytics` service
 * (analytics.ts) — a no-op when the `ANALYTICS` binding is absent.
 */

import { DEFAULT_QUERY_MAX_CELLS, Histogram, type Principal, type PullElemPred, type PullPattern, type QueryStats, RateMeter, allows, componentLogger, fromJson, isSuperuser, normalizePullPattern, pull, query, setTelemetryLevel, toJson } from "../internal/core/index.ts";
import type { Db as CoreDb } from "../internal/core/index.ts";
import type { RamoseEnv } from "../RamoseEnv.ts";
import { envInt, internalHeaders } from "../internal/transactor/index.ts";
import { TransactorDO } from "../internal/transactor/transactor-do.ts";
import { QueryReplicaDO } from "../internal/replica/index.ts";
import * as Effect from "effect/Effect";
import { Analytics, type Route, bindingOf, fromBinding, httpPoint, routeOf } from "./analytics.ts";
import { allowedOrigin, allowsRawTransact, authState, cachedProvision, checkWrite, describePrincipal, isTokenOnly, principalOf, rememberProvisioned, shouldProvision, viewDb } from "./auth.ts";
import { isDatabaseName } from "../db/DatabaseName.ts";
import { BadRequest, type Internal, NotFound, OperationRejected, type QueryBudgetExceeded, type RamoseError, Unauthorized, UpstreamError, fromThrown, toHttp } from "./errors.ts";
import { operationNames } from "../db/Operation.ts";
import { type ServerOptions, prepareOperation } from "./operations.ts";
export type { ServerOptions } from "./operations.ts";
import { basisHeaders, coloHeader, fetchBasisWithStats, hintOf, invalidateBasis, nearestReplica, regionOf, replicaId, segmentSource } from "./peer.ts";
import { PRINCIPAL_HEADER } from "./session.ts";
import { WRITES_HEADER, isUnrecognizedWrites, resolveWrites } from "../writes.ts";
export { resolveWrites } from "../writes.ts";
import { DEMO_HTML } from "./demo.ts";

export { TransactorDO, QueryReplicaDO };
export type { RamoseEnv } from "../RamoseEnv.ts";
export { type ErrorHttp, errorResponse, errorToHttp, statusOf, toDbError } from "../errorHttp.ts";
export { toHttp, fromThrown, isRamoseError } from "./errors.ts";

// ---- peer metrics (per isolate) --------------------------------------------
const plog = componentLogger("peer");
const peerMetrics = {
  queries: new RateMeter(10_000),
  transacts: new RateMeter(10_000),
  queryMs: new Histogram(),
  transactMs: new Histogram(),
  budgetAborts: 0,
  errors: 0,
  aeWrites: 0,
};
let levelApplied = false;
const writesWarned = new Set<string>();
const unrecognizedWritesWarned = new Set<string>();

/** Test hook: forget the policy + writes: "all" / unrecognized-env warnings. */
export const clearWritesWarning = (): void => {
  writesWarned.clear();
  unrecognizedWritesWarned.clear();
};

const WRITES_ALL_POLICY_EVENT = "writes.all-with-policy";
const WRITES_UNRECOGNIZED_EVENT = "writes.unrecognized";

function warnWritesAll(env: RamoseEnv, writes: "all" | "operations"): void {
  if (writes !== "all" || authState(env).policy === undefined) return;
  const key = env.RAMOSE_POLICY ?? "";
  if (writesWarned.has(key)) return;
  writesWarned.add(key);
  plog.warn(WRITES_ALL_POLICY_EVENT, {
    message:
      'writes is "all" while a policy is installed — "all" only opens raw /transact when no policy is configured',
  });
}

function warnUnrecognizedWrites(envWrites: string | undefined): void {
  if (!isUnrecognizedWrites(envWrites)) return;
  const key = String(envWrites);
  if (unrecognizedWritesWarned.has(key)) return;
  unrecognizedWritesWarned.add(key);
  plog.warn(WRITES_UNRECOGNIZED_EVENT, {
    value: key,
    using: "operations",
    message: `RAMOSE_WRITES=${JSON.stringify(key)} is not "all" or "operations"; using "operations"`,
  });
}

/** `tx` from a `/transact` body; parse failure is not schema. */
function txOf(body: string | undefined): unknown {
  if (body === undefined || body === "") return undefined;
  try {
    return (JSON.parse(body) as { tx?: unknown }).tx;
  } catch {
    return undefined;
  }
}

/**
 * Every attribute a pull pattern names that this database's schema does not
 * declare (recursing through nested `sub` patterns).
 *
 * `pull` itself skips unknown attributes — Datomic throws, we were lenient —
 * which made a pull against an uninstalled database silently return a subset
 * instead of failing like `query` does. The API contract is that both are
 * `InvalidRequest`, so the check lives here, one layer above the engine.
 */
function unknownPullAttrs(db: CoreDb, pattern: PullPattern, seen: string[] = []): string[] {
  for (const spec of pattern) {
    if (spec.kind !== "attr") continue;
    if (spec.attr !== ":db/id") noteUnknown(db, spec.attr, seen);
    // a nested collection's :where / :order walk paths of their own
    for (const p of spec.where ?? []) unknownElemPredAttrs(db, p, seen);
    for (const o of spec.order ?? []) unknownPathAttrs(db, o.path, seen);
    if (spec.sub !== undefined) unknownPullAttrs(db, spec.sub, seen);
  }
  return seen;
}

function noteUnknown(db: CoreDb, ident: string, seen: string[]): void {
  if (db.attr(ident) === undefined && !seen.includes(ident)) seen.push(ident);
}

function unknownPathAttrs(db: CoreDb, path: readonly string[], seen: string[]): void {
  for (const ident of path) if (ident !== ":db/id") noteUnknown(db, ident, seen);
}

function unknownElemPredAttrs(db: CoreDb, pred: PullElemPred, seen: string[]): void {
  if ("and" in pred) for (const p of pred.and) unknownElemPredAttrs(db, p, seen);
  else if ("or" in pred) for (const p of pred.or) unknownElemPredAttrs(db, p, seen);
  else if ("not" in pred) unknownElemPredAttrs(db, pred.not, seen);
  else if ("every" in pred) {
    unknownPathAttrs(db, pred.every.path, seen);
    unknownElemPredAttrs(db, pred.every.pred, seen);
  } else if ("some" in pred) {
    unknownPathAttrs(db, pred.some.path, seen);
    unknownElemPredAttrs(db, pred.some.pred, seen);
  } else unknownPathAttrs(db, pred.path, seen);
}

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(toJson(body)), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*", ...extra },
  });

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type,authorization,upgrade,x-ramose-replica-hint,x-ramose-cache-basis,x-ramose-cache-mode,x-ramose-min-t",
  "access-control-expose-headers": "x-ramose-ms,x-ramose-r2-gets,x-ramose-cache-hits,x-ramose-basis-t,x-ramose-basis-hit,x-ramose-basis-reason,x-ramose-basis-calls,x-ramose-basis-behind,x-ramose-replica-hint,x-ramose-cache-basis,x-ramose-cache-mode,x-ramose-colo",
};

/** Narrow `access-control-allow-origin` to `RAMOSE_ALLOWED_ORIGINS` once a policy is configured. */
function withCors(env: RamoseEnv, request: Request, res: Response): Response {
  const origin = allowedOrigin(env, request);
  if (origin === undefined || res.status === 101) return res;
  const headers = new Headers(res.headers);
  if (origin === null) headers.delete("access-control-allow-origin");
  else headers.set("access-control-allow-origin", origin);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

const validDbName = isDatabaseName;

/** What the request turned out to be — filled in as it is routed; used by the error log and the AE point. */
interface RequestInfo {
  db: string;
  path: string;
  route: Route;
}

/** Tagged failure → the response this Worker has always returned for it. */
function respond(err: RamoseError): Response {
  const h = toHttp(err);
  if (h.raw !== undefined) return new Response(h.raw, { status: h.status, headers: h.headers ?? { "content-type": "application/json", ...CORS } });
  return json(h.body ?? {}, h.status);
}

/** `Effect.catchTags` handlers: same statuses/bodies as before, plus the metrics and logs each used to bump. */
const recover = (info: RequestInfo, t0: number) => ({
  NotFound: (e: NotFound) => Effect.sync(() => respond(e)),
  BadRequest: (e: BadRequest) => Effect.sync(() => respond(e)),
  Unauthorized: (e: Unauthorized) => Effect.sync(() => respond(e)),
  UpstreamError: (e: UpstreamError) => Effect.sync(() => respond(e)),
  QueryBudgetExceeded: (e: QueryBudgetExceeded) =>
    Effect.sync(() => {
      // planner memory guardrail: clear, tagged, retryable-with-a-narrower-query — never an OOM
      peerMetrics.budgetAborts++;
      plog.warn("query.budget-exceeded", { db: info.db, clause: e.clause, cells: e.cells, limit: e.limit, spentBy: e.spentBy ?? "caller", ms: Date.now() - t0 });
      return respond(e);
    }),
  Internal: (e: Internal) =>
    Effect.sync(() => {
      peerMetrics.errors++;
      plog.error("request.error", { db: info.db, path: info.path, error: e.message });
      return respond(e);
    }),
  OperationRejected: (e: OperationRejected) => Effect.sync(() => respond(e)),
});

/** One Analytics Engine point per request; never fails or delays the response. */
const recordHttp = (request: Request, info: RequestInfo, status: number, ms: number) =>
  Effect.gen(function* () {
    const ae = yield* Analytics;
    if (!ae.bound) return;
    yield* ae.writeDataPoint(httpPoint({ db: info.db, colo: (request as { cf?: { colo?: string } }).cf?.colo, route: info.route, status, ms }));
    peerMetrics.aeWrites++;
  }).pipe(Effect.ignoreCause);

/**
 * The ingress pre-check at the replica's basis, and the principal the
 * Transactor DO will trust. Best effort — anything but a denial falls through
 * to the writer, which checks authoritatively anyway.
 */
async function ingress(request: Request, env: RamoseEnv, db: string, principal: Principal, text: string, t0: number): Promise<{ body: string; done?: undefined } | { done: Response }> {
  let raw: { tx?: unknown; clientTxId?: unknown };
  try {
    raw = JSON.parse(text) as { tx?: unknown; clientTxId?: unknown };
  } catch {
    throw new BadRequest({ message: "body must be { tx: [...] }" });
  }
  const tx = fromJson(raw?.tx);
  const clientTxId = typeof raw.clientTxId === "string" && raw.clientTxId.length > 0 ? raw.clientTxId : undefined;
  const forward = (ops: unknown, p: Principal = principal) => ({
    body: JSON.stringify({ tx: toJson(ops), principal: p, ...(clientTxId !== undefined ? { clientTxId } : {}) }),
  });
  if (!Array.isArray(tx)) return forward(tx);
  try {
    const bf = await fetchBasisWithStats(env, db, request);
    const checked = await checkWrite(env, principal, segmentSource(env, db), bf.basis, tx);
    // a no-op `ensure`: the idents are already deployed, so there is nothing to transact
    if (checked.kind === "skip") return { done: json({ t: bf.basis.t, txEid: 0, tempids: {}, datoms: [], ...(clientTxId !== undefined ? { clientTxId } : {}) }, 200, { "x-ramose-ms": String(Date.now() - t0) }) };
    return forward(checked.tx, checked.principal);
  } catch (err) {
    if ((err as { _tag?: string })?._tag === "Unauthorized") throw err;
    return forward(tx);
  }
}

/**
 * Session-establishment write: upsert the caller's principal row on the
 * writer before any client op. Cached per isolate per `(sub, db, class)`.
 */
async function withProvisioned(
  env: RamoseEnv,
  principal: Principal,
  db: string,
  transactor: () => { fetch: (url: string, init?: RequestInit) => Promise<Response> },
  txUrl: (path: string) => string,
  request: Request,
): Promise<Principal> {
  if (authState(env).policy === undefined || !shouldProvision(principal)) return principal;
  const hit = cachedProvision(principal);
  if (hit !== undefined) return { ...principal, eid: hit };
  try {
    const res = await transactor().fetch(txUrl("/provision"), {
      method: "POST",
      headers: { "content-type": "application/json", ...coloHeader(request), ...internalHeaders(env) },
      body: JSON.stringify({ principal }),
    });
    if (!res.ok) return principal;
    const body = (await res.json()) as { eid?: unknown };
    if (typeof body.eid !== "number") return principal;
    invalidateBasis(db);
    return rememberProvisioned(principal, body.eid);
  } catch {
    return principal;
  }
}

/** Everything that used to live inside the Worker's try/…/catch; throws tagged failures. */
async function route(request: Request, env: RamoseEnv, url: URL, db: string, rest: string, principal: Principal, t0: number, peer: ServerOptions): Promise<Response> {
  const transactor = () => env.TRANSACTOR.get(env.TRANSACTOR.idFromName(db));
  const txUrl = (path: string) => `https://transactor${path}${path.includes("?") ? "&" : "?"}db=${encodeURIComponent(db)}`;
  const policy = authState(env).policy;
  // re-asserted here, so a session frame is judged on the name it actually opened
  if (!allows(principal, db)) throw new Unauthorized({ message: "token is not valid for this database" });
  if (isTokenOnly(principal) && !(rest === "/transact" && request.method === "POST")) throw new Unauthorized({});
  principal = await withProvisioned(env, principal, db, transactor, txUrl, request);
  const adminOnly = () => {
    if (policy !== undefined && !isSuperuser(principal, policy)) throw new Unauthorized({ status: 403, message: "superuser only", code: "policy" });
  };
  const writes = resolveWrites(peer.writes, env.RAMOSE_WRITES);
  warnWritesAll(env, writes);
  warnUnrecognizedWrites(env.RAMOSE_WRITES);
  let transactBody: string | undefined;
  if (rest === "/transact" && request.method === "POST") {
    transactBody = await request.text();
    if (!allowsRawTransact(writes, principal, txOf(transactBody), policy)) {
      throw new Unauthorized({
        status: 403,
        message: "raw transact is disabled; use operations",
        code: "operations",
      });
    }
  }

  // ---- writes → Transactor DO
  if (rest === "/op" && request.method === "POST") {
    let raw: { name?: unknown; entity?: unknown; input?: unknown; clientOpId?: unknown };
    try {
      raw = JSON.parse(await request.text()) as typeof raw;
    } catch {
      throw new BadRequest({ message: "body must be { name, input, clientOpId? }" });
    }
    const opName = typeof raw.name === "string" ? raw.name : "";
    if (opName.length === 0) throw new BadRequest({ message: "body must be { name, input, clientOpId? }" });
    const clientOpId =
      typeof raw.clientOpId === "string" && raw.clientOpId.length > 0 ? raw.clientOpId : undefined;

    if (clientOpId !== undefined) {
      const replay = await transactor().fetch(txUrl("/op-ack"), {
        method: "POST",
        headers: { "content-type": "application/json", ...internalHeaders(env) },
        body: JSON.stringify({ clientOpId, principal }),
      });
      if (replay.ok) {
        const hit = fromJson(await replay.json()) as { ack?: Record<string, unknown> | null };
        if (hit?.ack !== undefined && hit.ack !== null) {
          return json({ ...hit.ack, clientOpId }, 200, { "x-ramose-ms": String(Date.now() - t0) });
        }
      }
    }

    const prepared = await prepareOperation({
      env,
      request,
      db,
      principal,
      registry: peer.operations,
      name: opName,
      entity: raw.entity,
      input: raw.input,
      clientOpId,
    });

    const tx = prepared.tx;
    const who = prepared.principal;

    if (tx.length === 0) {
      const bf = await fetchBasisWithStats(env, db, request);
      const emptyAck = {
        t: bf.basis.t,
        txEid: 0,
        tempids: {},
        datoms: [],
        output: await prepared.encodeOutput({}),
        ...(clientOpId !== undefined ? { clientTxId: clientOpId } : {}),
      };
      if (clientOpId !== undefined) {
        await transactor().fetch(txUrl("/op-ack"), {
          method: "POST",
          headers: { "content-type": "application/json", ...internalHeaders(env) },
          body: JSON.stringify({ clientOpId, principal: who, ack: emptyAck }),
        });
      }
      return json({ ...emptyAck, ...(clientOpId !== undefined ? { clientOpId } : {}) }, 200, {
        "x-ramose-ms": String(Date.now() - t0),
      });
    }

    // Do not forward `prepared.output`: it still holds live TxHandles. Tempids
    // are assigned by the commit, so encode + persist happen after /transact.
    const forward = JSON.stringify({
      tx: toJson(tx),
      principal: who,
      fromOperation: true,
      ...(clientOpId !== undefined ? { clientTxId: clientOpId } : {}),
    });
    const res = await transactor().fetch(txUrl("/transact"), {
      method: "POST",
      body: forward,
      headers: { "content-type": "application/json", ...coloHeader(request), ...internalHeaders(env) },
    });
    invalidateBasis(db);
    const ms = Date.now() - t0;
    peerMetrics.transacts.mark(1);
    peerMetrics.transactMs.observe(ms);
    const headers = { "content-type": "application/json", ...CORS, "x-ramose-ms": String(ms) };
    if (!res.ok) throw new UpstreamError({ status: res.status, body: await res.text(), headers });
    const ack = fromJson(await res.json()) as Record<string, unknown>;
    const tempids =
      ack.tempids !== null && typeof ack.tempids === "object"
        ? (ack.tempids as Record<string, number>)
        : {};
    const output = await prepared.encodeOutput(tempids);
    const persisted = { ...ack, output };
    if (clientOpId !== undefined) {
      await transactor().fetch(txUrl("/op-ack"), {
        method: "POST",
        headers: { "content-type": "application/json", ...internalHeaders(env) },
        body: JSON.stringify({ clientOpId, principal: who, ack: persisted }),
      });
    }
    return json({ ...persisted, ...(clientOpId !== undefined ? { clientOpId } : {}) }, 200, headers);
  }
  if (rest === "/transact" && request.method === "POST") {
    let body = transactBody ?? "";
    if (policy !== undefined) {
      const sent = await ingress(request, env, db, principal, body, t0);
      if (sent.done !== undefined) return sent.done;
      body = sent.body;
    }
    const res = await transactor().fetch(txUrl("/transact"), { method: "POST", body, headers: { "content-type": "application/json", ...coloHeader(request), ...internalHeaders(env) } });
    invalidateBasis(db); // a write through this Worker must be visible to this isolate's next cached read
    const ms = Date.now() - t0;
    peerMetrics.transacts.mark(1);
    peerMetrics.transactMs.observe(ms);
    plog.debug("transact", { db, status: res.status, ms });
    const headers = { "content-type": "application/json", ...CORS, "x-ramose-ms": String(Date.now() - t0) };
    if (!res.ok) throw new UpstreamError({ status: res.status, body: await res.text(), headers });
    return new Response(res.body, { status: res.status, headers });
  }
  if (rest === "/admin/replica/reconnect" && request.method === "POST") {
    adminOnly();
    // chaos/ops: drop the nearest replica's novelty subscription; it must resume with no missed datoms
    const res = await env.REPLICA.get(replicaId(env, db, regionOf(request), 1, hintOf(request, env))).fetch(`https://replica/admin/reconnect?db=${encodeURIComponent(db)}`, { method: "POST", headers: { ...coloHeader(request), ...internalHeaders(env) } });
    const headers = { "content-type": "application/json", ...CORS };
    if (!res.ok) throw new UpstreamError({ status: res.status, body: await res.text(), headers });
    return new Response(res.body, { status: res.status, headers });
  }
  if (rest.startsWith("/admin/") && request.method === "POST") {
    adminOnly();
    const res = await transactor().fetch(txUrl(rest), { method: "POST", headers: { ...coloHeader(request), ...internalHeaders(env) } });
    const headers = { "content-type": "application/json", ...CORS };
    if (!res.ok) throw new UpstreamError({ status: res.status, body: await res.text(), headers });
    return new Response(res.body, { status: res.status, headers });
  }

  // ---- reads → replica basis + local execution
  if (rest === "/query" && request.method === "POST") {
    const body = fromJson(await request.json()) as { query: unknown; inputs?: unknown[]; asOf?: number; history?: boolean; explain?: boolean };
    if (!body?.query) throw new BadRequest({ message: "body must be { query, inputs? }" });
    if (body.explain) adminOnly(); // planner metadata is not filtered
    const bf = await fetchBasisWithStats(env, db, request);
    const basis = bf.basis;
    const store = segmentSource(env, db);
    const dbv = await viewDb(env, principal, store, basis, { asOf: typeof body.asOf === "number" ? body.asOf : undefined, history: !!body.history });
    const stats: QueryStats = { clauses: [] };
    const before = { ...store.stats };
    const result = await query(dbv, body.query as any, body.inputs ?? [], { stats, maxCells: envInt(env.RAMOSE_QUERY_MAX_CELLS, DEFAULT_QUERY_MAX_CELLS) });
    const after = store.stats;
    const ms = Date.now() - t0;
    peerMetrics.queries.mark(1);
    peerMetrics.queryMs.observe(ms);
    plog.debug("query", { db, ms, rows: Array.isArray(result) ? result.length : 1, basisT: basis.t, basisHit: bf.hit, basisReason: bf.reason, novelty: basis.novelty.length, r2Gets: after.r2Gets - before.r2Gets, cacheHits: after.cacheHits - before.cacheHits, peakCells: stats?.budget?.peakCells });
    return json(
      { t: basis.t, root: basis.root.t, result, ...(body.explain ? { explain: stats.clauses, budget: stats.budget } : {}) },
      200,
      { "x-ramose-ms": String(Date.now() - t0), "x-ramose-r2-gets": String(after.r2Gets - before.r2Gets), "x-ramose-cache-hits": String(after.cacheHits - before.cacheHits), ...basisHeaders(request, env, bf) },
    );
  }
  if (rest === "/pull" && request.method === "POST") {
    const body = fromJson(await request.json()) as { eid: number | string | [string, unknown]; pattern: unknown; asOf?: number; history?: boolean };
    const bf = await fetchBasisWithStats(env, db, request);
    const basis = bf.basis;
    const dbv = await viewDb(env, principal, segmentSource(env, db), basis, { asOf: typeof body.asOf === "number" ? body.asOf : undefined, history: !!body.history });
    // an attribute this database has never installed is a bad request, not a
    // silently missing key — the pull engine is lenient, the API is not
    const pattern = normalizePullPattern(body.pattern);
    const unknown = unknownPullAttrs(dbv, pattern);
    if (unknown.length > 0) throw new BadRequest({ message: `unknown attribute${unknown.length > 1 ? "s" : ""} in pull pattern: ${unknown.join(", ")}` });
    const eid = typeof body.eid === "number" ? body.eid : await dbv.entid(body.eid as any);
    if (eid === undefined) return json({ t: basis.t, result: null }, 200, { "x-ramose-ms": String(Date.now() - t0), ...basisHeaders(request, env, bf) });
    return json({ t: basis.t, result: await pull(dbv, eid, pattern) }, 200, { "x-ramose-ms": String(Date.now() - t0), ...basisHeaders(request, env, bf) });
  }
  const em = /^\/entity\/(\d+)$/.exec(rest);
  if (em && request.method === "GET") {
    const bf = await fetchBasisWithStats(env, db, request);
    const basis = bf.basis;
    const asOf = url.searchParams.has("asOf") ? Number(url.searchParams.get("asOf")) : undefined;
    const dbv = await viewDb(env, principal, segmentSource(env, db), basis, { asOf });
    return json({ t: basis.t, entity: await dbv.entity(Number(em[1])) }, 200, { "x-ramose-ms": String(Date.now() - t0), ...basisHeaders(request, env, bf) });
  }
  if (rest === "/info" && request.method === "GET") {
    // every principal may ask where the basis is; only superuser sees the peer's internals.
    // top-level `t` is the one shape both answers share — it is what `db.basis()` reads.
    // `principal` is on both too: it is what `db.principal()` reads. The peer
    // provisions the row at session establishment, so `eid` is set for any
    // signed-in user once the principal attr is deployed.
    const basis = (await fetchBasisWithStats(env, db, request)).basis;
    const basisT = basis.t;
    const who = await describePrincipal(env, principal, segmentSource(env, db), basis);
    if (policy !== undefined && !isSuperuser(principal, policy)) {
      return json({ db, t: basisT, principal: who }, 200, { "x-ramose-ms": String(Date.now() - t0) });
    }
    // A DO that is still provisioning answers 500 "Worker not found." as
    // JSON. Swallowing that into `r.json()` made `/info` 200 while the
    // first write still failed — e2e warmup treated it as ready.
    const doJson = async (res: Response): Promise<unknown> => {
      const body = await res.text();
      if (!res.ok) throw new UpstreamError({ status: res.status, body });
      return JSON.parse(body);
    };
    const [tx, rep] = await Promise.all([
      transactor().fetch(txUrl("/info"), { headers: { ...coloHeader(request), ...internalHeaders(env) } }).then(doJson),
      env.REPLICA.get(replicaId(env, db, regionOf(request), 1, hintOf(request, env))).fetch(`https://replica/info?db=${encodeURIComponent(db)}`, { headers: { ...coloHeader(request), ...internalHeaders(env) } }).then(doJson),
    ]);
    return json({
      db,
      t: basisT,
      principal: who,
      region: regionOf(request),
      transactor: tx,
      replica: rep,
      peer: segmentSource(env, db).stats,
      peerMetrics: { queriesPerSec: peerMetrics.queries.rate(), transactsPerSec: peerMetrics.transacts.rate(), queryMs: peerMetrics.queryMs.snapshot(), transactMs: peerMetrics.transactMs.snapshot(), budgetAborts: peerMetrics.budgetAborts, errors: peerMetrics.errors },
      worker: { aeWrites: peerMetrics.aeWrites, analytics: bindingOf(env) !== undefined },
    });
  }
  // session socket: verify here, then upgrade onto the replica this request
  // would already query (`watchKey` / replica hint stays the pin). Follow
  // lives on that replica after applyDatoms — the Worker is not the cursor.
  if (rest === "/session" && request.method === "GET") {
    if ((request.headers.get("Upgrade") ?? "").toLowerCase() !== "websocket") throw new BadRequest({ message: "expected websocket" });
    const headers = new Headers({
      Upgrade: "websocket",
      ...internalHeaders(env),
      ...coloHeader(request),
    });
    const hint = hintOf(request, env);
    if (hint) headers.set("x-ramose-replica-hint", hint);
    headers.set(PRINCIPAL_HEADER, JSON.stringify(principal));
    headers.set(WRITES_HEADER, writes);
    const res = await nearestReplica(env, db, request).fetch(`https://replica/session?db=${encodeURIComponent(db)}`, { headers });
    if (!res.webSocket) {
      const headersOut = { "content-type": "application/json", ...CORS };
      throw new UpstreamError({ status: res.status === 101 ? 502 : res.status, body: await res.text(), headers: headersOut });
    }
    plog.debug("session.open", { db, colo: (request as { cf?: { colo?: string } }).cf?.colo });
    return new Response(null, { status: 101, webSocket: res.webSocket });
  }
  throw new NotFound({});
}

/** The request, as one Effect: `Response` on success, a tagged failure otherwise. */
const handle = (request: Request, env: RamoseEnv, t0: number, info: RequestInfo, peer: ServerOptions): Effect.Effect<Response, RamoseError> =>
  Effect.gen(function* () {
    if (!levelApplied) {
      levelApplied = true;
      const lvl = env.RAMOSE_LOG_LEVEL;
      if (lvl === "debug" || lvl === "info" || lvl === "warn" || lvl === "error") setTelemetryLevel(lvl);
    }
    const url = new URL(request.url);
    info.path = url.pathname;
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === "/" || url.pathname === "/index.html") {
      // a peer that enforces a policy is not a demo console
      if (authState(env).configured) return yield* Effect.fail(new NotFound({}));
      return new Response(DEMO_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (url.pathname === "/health") {
      info.route = "health";
      return json({
        ok: true,
        service: "ramose",
        stage: env.RAMOSE_STAGE ?? "dev",
        time: Date.now(),
        operations: operationNames(peer.operations),
      });
    }

    const m = /^\/db\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (!m) return yield* Effect.fail(new NotFound({}));
    const db = decodeURIComponent(m[1]);
    const rest = m[2] ?? "/";
    info.db = db;
    info.path = rest;
    info.route = routeOf(rest, request.method);
    if (!validDbName(db)) return yield* Effect.fail(new BadRequest({ message: "invalid database name" }));
    // the verified caller is a positional argument of `route`: no header sniffing downstream
    const principal = yield* Effect.tryPromise({
      try: () => principalOf(env, request, db),
      catch: (err) => fromThrown(err, { stacks: env.RAMOSE_STAGE !== "prod" }),
    });

    return yield* Effect.tryPromise({
      try: () => route(request, env, url, db, rest, principal, t0, peer),
      catch: (err) => fromThrown(err, { stacks: env.RAMOSE_STAGE !== "prod" }),
    });
  });

const runFetch = (
  request: Request,
  env: RamoseEnv,
  peer: ServerOptions,
): Promise<Response> => {
  const t0 = Date.now();
  const info: RequestInfo = { db: "-", path: "-", route: "other" };
  return Effect.runPromise(
    handle(request, env, t0, info, peer).pipe(
      Effect.catchTags(recover(info, t0)),
      Effect.map((res) => withCors(env, request, res)),
      Effect.tap((res) => recordHttp(request, info, res.status, Date.now() - t0)),
      Effect.provideService(Analytics, fromBinding(bindingOf(env))),
    ),
  );
};

/**
 * Build a peer Worker over a bundled operations registry.
 * Raw `/transact` is closed for app-class tokens by default (`writes:
 * "operations"` / unset `RAMOSE_WRITES`). `"all"` is the explicit opt-out.
 * Admin and the seed token (`$token`) keep `/transact`.
 */
export const createServer = (options: ServerOptions = {}) => ({
  async fetch(request: Request, env: RamoseEnv, _ctx?: ExecutionContext): Promise<Response> {
    return runFetch(request, env, options);
  },
});

export default createServer();
