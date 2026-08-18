/**
 * Ripple peer Worker — the HTTP API and the edge datalog executor.
 *
 * Read-path knobs (per request by header, default by env — see peer.ts):
 * `x-ripple-replica-hint: wnam|enam|…|auto|continent` picks the replica DO placement
 * (hint is part of the DO id; default `auto` = colo→hint); `x-ripple-cache-basis: 0|1`
 * (default 1) reuses an isolate-cached basis instead of calling the replica each read;
 * `x-ripple-cache-mode: ttl|peer` (default ttl = 5 s) picks the cache's consistency story;
 * `x-ripple-min-t: <t>` makes a read refetch if the cached basis is older than t.
 *
 *   GET  /                                  demo app (CRUD + as-of history view)
 *   GET  /health
 *   POST /db/:name/transact   { tx }        → { t, txEid, tempids, datoms }
 *   POST /db/:name/query      { query, inputs?, asOf?, history? }   → { t, result }
 *   POST /db/:name/pull       { eid, pattern, asOf?, history? }     → { t, result }
 *   GET  /db/:name/entity/:eid[?asOf=]                              → { t, entity }
 *   GET  /db/:name/info                                            → { db, t, principal, … } — `t` and `principal` for everyone; transactor/replica internals for admin
 *   GET  /db/:name/session    (Upgrade: websocket)                 → the session socket (session.ts)
 *   POST /db/:name/admin/index | /admin/gc                         → indexer controls
 *
 * Reads: basis (root + novelty) from the nearest QueryReplica DO → Db over
 * cached segments → datalog here in the Worker. Writes: forwarded to the
 * Transactor DO. Auth: a bearer token resolved to a `Principal` per request
 * (auth.ts) — a verified JWT under `RIPPLE_POLICY`, else the legacy shared
 * `RIPPLE_TOKEN`; the policy filters reads and checks writes.
 *
 * The request is one Effect: routing failures are `Data.TaggedError`s
 * (errors.ts) mapped back to responses with `Effect.catchTags`, and every
 * request emits one Analytics Engine point through the `Analytics` service
 * (analytics.ts) — a no-op when the `ANALYTICS` binding is absent.
 */

import { DEFAULT_QUERY_MAX_CELLS, Histogram, type Principal, type PullElemPred, type PullPattern, type QueryStats, RateMeter, allows, componentLogger, fromJson, isAdmin, normalizePullPattern, pull, query, setTelemetryLevel, toJson } from "@ripple/core";
import type { Db as CoreDb } from "@ripple/core";
import { type RippleEnv, envInt, internalHeaders } from "@ripple/transactor";
import { TransactorDO } from "@ripple/transactor/transactor-do.ts";
import { QueryReplicaDO } from "@ripple/replica";
import * as Effect from "effect/Effect";
import { Analytics, type Route, bindingOf, fromBinding, httpPoint, routeOf } from "./analytics.ts";
import { allowedOrigin, authState, checkWrite, describePrincipal, isTokenOnly, principalForToken, principalOf, viewDb } from "./auth.ts";
import { BadRequest, type Internal, NotFound, type QueryBudgetExceeded, type RippleError, Unauthorized, UpstreamError, fromThrown, toHttp } from "./errors.ts";
import { basisHeaders, coloHeader, fetchBasisWithStats, hintOf, invalidateBasis, regionOf, replicaId, segmentSource } from "./peer.ts";
import { type SocketLike, openSession } from "./session.ts";
import { DEMO_HTML } from "./demo.ts";

export { TransactorDO, QueryReplicaDO };

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
  "access-control-allow-headers": "content-type,authorization,upgrade,x-ripple-replica-hint,x-ripple-cache-basis,x-ripple-cache-mode,x-ripple-min-t",
  "access-control-expose-headers": "x-ripple-ms,x-ripple-r2-gets,x-ripple-cache-hits,x-ripple-basis-t,x-ripple-basis-hit,x-ripple-basis-reason,x-ripple-basis-calls,x-ripple-basis-behind,x-ripple-replica-hint,x-ripple-cache-basis,x-ripple-cache-mode,x-ripple-colo",
};

/** Narrow `access-control-allow-origin` to `RIPPLE_ALLOWED_ORIGINS` once a policy is configured. */
function withCors(env: RippleEnv, request: Request, res: Response): Response {
  const origin = allowedOrigin(env, request);
  if (origin === undefined || res.status === 101) return res;
  const headers = new Headers(res.headers);
  if (origin === null) headers.delete("access-control-allow-origin");
  else headers.set("access-control-allow-origin", origin);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function validDbName(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name);
}

/** What the request turned out to be — filled in as it is routed; used by the error log and the AE point. */
interface RequestInfo {
  db: string;
  path: string;
  route: Route;
}

/** Tagged failure → the response this Worker has always returned for it. */
function respond(err: RippleError): Response {
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
      plog.warn("query.budget-exceeded", { db: info.db, clause: e.clause, cells: e.cells, limit: e.limit, ms: Date.now() - t0 });
      return respond(e);
    }),
  Internal: (e: Internal) =>
    Effect.sync(() => {
      peerMetrics.errors++;
      plog.error("request.error", { db: info.db, path: info.path, error: e.message });
      return respond(e);
    }),
});

/** One Analytics Engine point per request; never fails or delays the response. */
const recordHttp = (request: Request, info: RequestInfo, status: number, ms: number) =>
  Effect.gen(function* () {
    const ae = yield* Analytics;
    if (!ae.bound) return;
    yield* ae.writeDataPoint(httpPoint({ db: info.db, colo: (request as { cf?: { colo?: string } }).cf?.colo, route: info.route, status, ms }));
    peerMetrics.aeWrites++;
  }).pipe(Effect.ignoreCause);

/** Session frame as a sub-request: inherit cf + replica hint from the upgrade. */
function subRequest(request: Request, env: RippleEnv, db: string, rest: string, init: { method: string; headers: Record<string, string>; body?: string }): Request {
  const headers = new Headers();
  const hint = hintOf(request, env);
  if (hint) headers.set("x-ripple-replica-hint", hint);
  for (const k of ["x-ripple-cache-basis", "x-ripple-cache-mode"]) {
    const v = request.headers.get(k);
    if (v !== null) headers.set(k, v);
  }
  for (const [k, v] of Object.entries(init.headers)) headers.set(k, v); // the frame's own headers win (min-t, content-type)
  return new Request(`https://session/db/${encodeURIComponent(db)}${rest}`, { method: init.method, headers, body: init.body, cf: (request as { cf?: unknown }).cf } as RequestInit);
}

/** GET /basis poll with the isolate cache off, so movement is visible. */
function pollRequest(request: Request, env: RippleEnv, db: string): Request {
  return subRequest(request, env, db, "/basis", { method: "GET", headers: { "x-ripple-cache-basis": "0" } });
}

/**
 * The ingress pre-check at the replica's basis, and the principal the
 * Transactor DO will trust. Best effort — anything but a denial falls through
 * to the writer, which checks authoritatively anyway.
 */
async function ingress(request: Request, env: RippleEnv, db: string, principal: Principal, text: string, t0: number): Promise<{ body: string; done?: undefined } | { done: Response }> {
  let raw: { tx?: unknown };
  try {
    raw = JSON.parse(text) as { tx?: unknown };
  } catch {
    throw new BadRequest({ message: "body must be { tx: [...] }" });
  }
  const tx = fromJson(raw?.tx);
  const forward = (ops: unknown, p: Principal = principal) => ({ body: JSON.stringify({ tx: toJson(ops), principal: p }) });
  if (!Array.isArray(tx)) return forward(tx);
  try {
    const bf = await fetchBasisWithStats(env, db, request);
    const checked = await checkWrite(env, principal, segmentSource(env, db), bf.basis, tx);
    // a no-op `ensure`: the idents are already deployed, so there is nothing to transact
    if (checked.kind === "skip") return { done: json({ t: bf.basis.t, txEid: 0, tempids: {}, datoms: 0 }, 200, { "x-ripple-ms": String(Date.now() - t0) }) };
    return forward(checked.tx, checked.principal);
  } catch (err) {
    if ((err as { _tag?: string })?._tag === "Unauthorized") throw err;
    return forward(tx);
  }
}

/** Everything that used to live inside the Worker's try/…/catch; throws tagged failures. */
async function route(request: Request, env: RippleEnv, url: URL, db: string, rest: string, principal: Principal, t0: number, ctx?: ExecutionContext): Promise<Response> {
  const transactor = () => env.TRANSACTOR.get(env.TRANSACTOR.idFromName(db));
  const txUrl = (path: string) => `https://transactor${path}${path.includes("?") ? "&" : "?"}db=${encodeURIComponent(db)}`;
  const policy = authState(env).policy;
  // re-asserted here, so a session frame is judged on the name it actually opened
  if (!allows(principal, db)) throw new Unauthorized({ message: "token is not valid for this database" });
  if (isTokenOnly(principal) && !(rest === "/transact" && request.method === "POST")) throw new Unauthorized({});
  const adminOnly = () => {
    if (policy !== undefined && !isAdmin(principal)) throw new Unauthorized({ status: 403, message: "admin only", code: "policy" });
  };

  // ---- writes → Transactor DO
  if (rest === "/transact" && request.method === "POST") {
    let body = await request.text();
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
    const headers = { "content-type": "application/json", ...CORS, "x-ripple-ms": String(Date.now() - t0) };
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
    const result = await query(dbv, body.query as any, body.inputs ?? [], { stats, maxCells: envInt(env.RIPPLE_QUERY_MAX_CELLS, DEFAULT_QUERY_MAX_CELLS) });
    const after = store.stats;
    const ms = Date.now() - t0;
    peerMetrics.queries.mark(1);
    peerMetrics.queryMs.observe(ms);
    plog.debug("query", { db, ms, rows: Array.isArray(result) ? result.length : 1, basisT: basis.t, basisHit: bf.hit, basisReason: bf.reason, novelty: basis.novelty.length, r2Gets: after.r2Gets - before.r2Gets, cacheHits: after.cacheHits - before.cacheHits, peakCells: stats?.budget?.peakCells });
    return json(
      { t: basis.t, root: basis.root.t, result, ...(body.explain ? { explain: stats.clauses, budget: stats.budget } : {}) },
      200,
      { "x-ripple-ms": String(Date.now() - t0), "x-ripple-r2-gets": String(after.r2Gets - before.r2Gets), "x-ripple-cache-hits": String(after.cacheHits - before.cacheHits), ...basisHeaders(request, env, bf) },
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
    if (eid === undefined) return json({ t: basis.t, result: null }, 200, { "x-ripple-ms": String(Date.now() - t0), ...basisHeaders(request, env, bf) });
    return json({ t: basis.t, result: await pull(dbv, eid, pattern) }, 200, { "x-ripple-ms": String(Date.now() - t0), ...basisHeaders(request, env, bf) });
  }
  const em = /^\/entity\/(\d+)$/.exec(rest);
  if (em && request.method === "GET") {
    const bf = await fetchBasisWithStats(env, db, request);
    const basis = bf.basis;
    const asOf = url.searchParams.has("asOf") ? Number(url.searchParams.get("asOf")) : undefined;
    const dbv = await viewDb(env, principal, segmentSource(env, db), basis, { asOf });
    return json({ t: basis.t, entity: await dbv.entity(Number(em[1])) }, 200, { "x-ripple-ms": String(Date.now() - t0), ...basisHeaders(request, env, bf) });
  }
  if (rest === "/info" && request.method === "GET") {
    // every principal may ask where the basis is; only admin sees the peer's internals.
    // top-level `t` is the one shape both answers share — it is what `db.basis()` reads.
    // `principal` is on both too: it is what `db.principal()` reads (`eid: null`
    // until the principal attribute has a row for this `sub`).
    const basis = (await fetchBasisWithStats(env, db, request)).basis;
    const basisT = basis.t;
    const who = await describePrincipal(env, principal, segmentSource(env, db), basis);
    if (policy !== undefined && !isAdmin(principal)) {
      return json({ db, t: basisT, principal: who }, 200, { "x-ripple-ms": String(Date.now() - t0) });
    }
    const [tx, rep] = await Promise.all([
      transactor().fetch(txUrl("/info"), { headers: { ...coloHeader(request), ...internalHeaders(env) } }).then((r) => r.json()),
      env.REPLICA.get(replicaId(env, db, regionOf(request), 1, hintOf(request, env))).fetch(`https://replica/info?db=${encodeURIComponent(db)}`, { headers: { ...coloHeader(request), ...internalHeaders(env) } }).then((r) => r.json()),
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
  // session socket
  if (rest === "/session" && request.method === "GET") {
    if ((request.headers.get("Upgrade") ?? "").toLowerCase() !== "websocket") throw new BadRequest({ message: "expected websocket" });
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();
    const session = openSession(server as unknown as SocketLike, {
      principal,
      authenticate: (token) => principalForToken(env, token.length === 0 ? undefined : token, db),
      describe: async (p) => describePrincipal(env, p, segmentSource(env, db), (await fetchBasisWithStats(env, db, request)).basis),
      dispatch: async (r, init, p) => {
        const sub = subRequest(request, env, db, r, init);
        try {
          // route matches on path; query string stays on the URL
          return await route(sub, env, new URL(sub.url), db, r.split("?")[0], p ?? principal, Date.now());
        } catch (err) {
          return respond(fromThrown(err, { stacks: env.RIPPLE_STAGE !== "prod" }));
        }
      },
      watchKey: `${db}|${hintOf(request, env) ?? ""}`,
      pollBasis: async () => (await fetchBasisWithStats(env, db, pollRequest(request, env, db))).basis.t,
    });
    // hold the request open until the socket closes
    ctx?.waitUntil(session.closed);
    plog.debug("session.open", { db, colo: (request as { cf?: { colo?: string } }).cf?.colo });
    return new Response(null, { status: 101, webSocket: client });
  }
  throw new NotFound({});
}

/** The request, as one Effect: `Response` on success, a tagged failure otherwise. */
const handle = (request: Request, env: RippleEnv, t0: number, info: RequestInfo, ctx?: ExecutionContext): Effect.Effect<Response, RippleError> =>
  Effect.gen(function* () {
    if (!levelApplied) {
      levelApplied = true;
      const lvl = env.RIPPLE_LOG_LEVEL;
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
      return json({ ok: true, service: "ripple", stage: env.RIPPLE_STAGE ?? "dev", time: Date.now() });
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
      catch: (err) => fromThrown(err, { stacks: env.RIPPLE_STAGE !== "prod" }),
    });

    return yield* Effect.tryPromise({
      try: () => route(request, env, url, db, rest, principal, t0, ctx),
      catch: (err) => fromThrown(err, { stacks: env.RIPPLE_STAGE !== "prod" }),
    });
  });

export default {
  async fetch(request: Request, env: RippleEnv, ctx?: ExecutionContext): Promise<Response> {
    const t0 = Date.now();
    const info: RequestInfo = { db: "-", path: "-", route: "other" };
    return Effect.runPromise(
      handle(request, env, t0, info, ctx).pipe(
        Effect.catchTags(recover(info, t0)),
        Effect.map((res) => withCors(env, request, res)),
        Effect.tap((res) => recordHttp(request, info, res.status, Date.now() - t0)),
        Effect.provideService(Analytics, fromBinding(bindingOf(env))),
      ),
    );
  },
};
