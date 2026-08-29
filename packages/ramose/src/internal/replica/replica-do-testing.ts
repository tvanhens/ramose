/**
 * Source-only QueryReplica assembly for Ramose's real local/Alchemy tests.
 *
 * Nothing in the supported `ramose/worker` graph imports this module. It owns
 * the deferred session protocol, diagnostic query/info routes, admin controls,
 * and mutable race boundaries that must not ship in the production Worker.
 */

import { DurableObject } from "cloudflare:workers";
import { Unauthorized } from "../../db/Errors.ts";
import type { Principal } from "../../worker/auth.ts";
import { fromEnv as jwtVerifierFromEnv } from "../../worker/jwt.ts";
import {
  type Session,
  type SessionState,
  type SocketLike,
  openSession,
  parsePrincipalHeader,
  PRINCIPAL_HEADER,
  TEST_SESSION_TOKEN_HEADER,
  WRITES_HEADER,
} from "../../worker/session.ts";
import {
  decideSessionTx,
  type SessionLog,
  type SessionLogEntry,
  type SessionTxDecision,
} from "../../worker/session-sync.ts";
import { type WritesMode, parseWritesHeader } from "../../writes.ts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  DEFAULT_QUERY_MAX_CELLS,
  type LogEntry,
  type QueryStats,
  type WireDatom,
  fromJson,
  query as runQuery,
  pull as runPull,
  toJson,
  toWireDatom,
} from "../core/index.ts";
import type { RuntimeBoundaries } from "../runtime-boundaries.ts";
import { type RamoseEnv, envInt, internalHeaders } from "../transactor/index.ts";
import { dbFromBasis, makeBasis } from "./basis.ts";
import { QueryReplicaDOBase, requestedMinT } from "./replica-do.ts";

const json = (
  body: unknown,
  status = 200,
  extra: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify(toJson(body)), {
    status,
    headers: { "content-type": "application/json", ...extra },
  });

export interface ReplicaTesting {
  readonly boundaries: RuntimeBoundaries;
  readonly enabled: (env: RamoseEnv) => boolean;
  readonly reset: () => void;
  readonly handleAdmin: (
    request: Request,
    path: string,
    abort: (reason: string) => void,
  ) => Promise<Response | undefined>;
}

/** @internal Explicit non-production assembly; never re-exported by `ramose/worker`. */
export const createTestingQueryReplicaDO = (
  testing: ReplicaTesting,
): (new (
  ctx: DurableObjectState,
  env: RamoseEnv,
) => DurableObject<RamoseEnv>) => class QueryReplicaDO extends QueryReplicaDOBase {
  /** Deferred test-session protocol objects rebuilt from hibernation attachments. */
  private readonly live = new Map<WebSocket, Session>();

  constructor(ctx: DurableObjectState, env: RamoseEnv) {
    super(ctx, env);
    if (testing.enabled(env)) testing.reset();
  }

  private get testingEnabled(): boolean {
    return testing.enabled(this.env);
  }

  protected override async beforeApplyDatoms(_entry: LogEntry): Promise<void> {
    if (this.testingEnabled) {
      await testing.boundaries.checkpoint("replica.apply");
    }
  }

  protected override async notifyAppliedEntry(entry: LogEntry): Promise<void> {
    if (!this.testingEnabled) return super.notifyAppliedEntry(entry);
    await testing.boundaries.checkpoint("session.notify");
    await super.notifyAppliedEntry(entry);
    await this.notifySessions(entry);
  }

  private sessionLog(): SessionLog {
    return {
      t: this.basisT,
      rootT: this.root?.t ?? 0,
      entries: this.entries.map((entry) => ({
        t: entry.t,
        datoms: entry.datoms.map(toWireDatom),
      })),
    };
  }

  private async sieve(
    _entry: SessionLogEntry,
    principal?: Principal,
  ): Promise<SessionTxDecision> {
    if (!this.root || !this.dbName) return { kind: "skip" };
    const basis = makeBasis(this.dbName, this.root, this.entries);
    const raw = await dbFromBasis(this.store, basis);
    return decideSessionTx({
      datoms: [],
      ...(principal === undefined ? {} : { principal }),
      ruleDbAfter: raw,
      ruleDbBefore: raw,
    });
  }

  private async snapshotView(
    _principal?: Principal,
  ): Promise<{ t: number; datoms: WireDatom[] }> {
    return { t: this.basisT, datoms: [] };
  }

  private async provisionPrincipal(principal: Principal): Promise<Principal> {
    if (this.dbName === undefined) return principal;
    const dbName = this.dbName;
    try {
      const stub = this.env.TRANSACTOR.get(
        this.env.TRANSACTOR.idFromName(dbName),
      );
      const response = await stub.fetch(
        `https://transactor/provision?db=${encodeURIComponent(dbName)}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...internalHeaders(this.env),
          },
          body: JSON.stringify({ principal }),
        },
      );
      if (!response.ok) return principal;
      const body = (await response.json()) as { eid?: unknown };
      return typeof body.eid === "number"
        ? { ...principal, eid: body.eid }
        : principal;
    } catch {
      return principal;
    }
  }

  private async authenticateTestSession(token: string): Promise<Principal> {
    if (!this.testingEnabled) throw new Unauthorized({});
    try {
      const verified = await Effect.runPromise(
        jwtVerifierFromEnv(this.env).verify(Redacted.make(token)),
      );
      return verified.principal;
    } catch {
      throw new Unauthorized({});
    }
  }

  private createSession(ws: WebSocket, seed: SessionState): Session {
    return openSession(ws as unknown as SocketLike, {
      listen: false,
      seed,
      ...(seed.principal === undefined ? {} : { principal: seed.principal }),
      dispatch: (rest, init, principal) =>
        this.sessionDispatch(rest, init, principal, seed.writes),
      authenticate: (token) => this.authenticateTestSession(token),
      provision: (principal) => this.provisionPrincipal(principal),
      describe: async (principal) => ({
        eid: principal.eid ?? null,
        class: principal.class,
      }),
      readLog: async () => {
        await this.sync();
        return this.sessionLog();
      },
      filterEntry: (entry, principal) => this.sieve(entry, principal),
      snapshot: (principal) => this.snapshotView(principal),
    });
  }

  private sessionOf(ws: WebSocket): Session {
    const hit = this.live.get(ws);
    if (hit !== undefined) return hit;
    const raw = typeof ws.deserializeAttachment === "function"
      ? ws.deserializeAttachment()
      : undefined;
    const seed = (raw ?? { lastT: 0, watermark: 0 }) as SessionState;
    const session = this.createSession(ws, seed);
    this.live.set(ws, session);
    return session;
  }

  private persist(ws: WebSocket, session: Session): void {
    try {
      ws.serializeAttachment?.(session.state());
    } catch {
      /* attachment is optional outside workerd */
    }
  }

  private async notifySessions(entry: LogEntry): Promise<void> {
    const sessionEntry: SessionLogEntry = {
      t: entry.t,
      datoms: entry.datoms.map(toWireDatom),
    };
    const rootT = this.root?.t ?? 0;
    for (const ws of this.ctx.getWebSockets() as WebSocket[]) {
      if (this.basisWatchOf(ws) !== undefined) continue;
      const session = this.sessionOf(ws);
      try {
        await session.applyEntry(sessionEntry, rootT);
        this.persist(ws, session);
      } catch {
        this.live.delete(ws);
        try {
          ws.close(1011, "session filter failed");
        } catch {
          /* already gone */
        }
      }
    }
  }

  private async sessionDispatch(
    rest: string,
    init: { method: string; headers: Record<string, string>; body?: string },
    _principal?: Principal,
    _writes?: WritesMode,
  ): Promise<Response> {
    await this.sync();
    await this.catchUpTo(requestedMinT(init.headers["x-ramose-min-t"]));
    if (!this.root) return json({ error: "database has no root yet" }, 503);
    if (rest === "/op" && init.method === "POST") {
      return json({ error: "operations must be POSTed to /db/:name/op" }, 400);
    }
    if (
      (rest === "/transact" && init.method === "POST") ||
      (rest === "/info" && init.method === "GET") ||
      (rest === "/query" && init.method === "POST") ||
      (rest === "/pull" && init.method === "POST") ||
      (/^\/entity\/(\d+)$/.test(rest.split("?")[0] ?? "") &&
        init.method === "GET")
    ) {
      return json({ error: "unauthorized" }, 401);
    }
    return json({ error: "not found" }, 404);
  }

  private async upgradeSession(request: Request): Promise<Response> {
    if ((request.headers.get("Upgrade") ?? "").toLowerCase() !== "websocket") {
      return json({ error: "expected websocket" }, 426);
    }
    await this.sync();
    let principal = parsePrincipalHeader(request.headers.get(PRINCIPAL_HEADER));
    const testToken = request.headers.get(TEST_SESSION_TOKEN_HEADER);
    if (testToken !== null) {
      try {
        principal = await this.authenticateTestSession(testToken);
      } catch {
        return json({ error: "unauthorized" }, 401);
      }
    }
    const provisioned = principal === undefined
      ? undefined
      : await this.provisionPrincipal(principal);
    const writes = parseWritesHeader(request.headers.get(WRITES_HEADER));
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    this.armWatch();
    const seed: SessionState = {
      ...(provisioned === undefined ? {} : { principal: provisioned }),
      ...(writes === undefined ? {} : { writes }),
      lastT: 0,
      watermark: 0,
    };
    const session = this.createSession(server, seed);
    this.live.set(server, session);
    this.persist(server, session);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    await this.init();
    if (this.basisWatchOf(ws) !== undefined) return;
    if (!this.testingEnabled) return super.webSocketMessage(ws, message);
    const session = this.sessionOf(ws);
    await session.onMessage(message);
    this.persist(ws, session);
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    if (this.basisWatchOf(ws) !== undefined || !this.testingEnabled) {
      return super.webSocketClose(ws, code);
    }
    const session = this.live.get(ws);
    session?.close();
    this.live.delete(ws);
    try {
      ws.close(code, "bye");
    } catch {
      /* already gone */
    }
  }

  protected override async route(
    request: Request,
    url: URL,
    dbName: string,
  ): Promise<Response> {
    if (!this.testingEnabled) return super.route(request, url, dbName);
    if (url.pathname === "/session") return this.upgradeSession(request);
    if (url.pathname === "/query") {
      await this.sync();
      await this.catchUpTo(requestedMinT(
        url.searchParams.get("minT") ?? request.headers.get("x-ramose-min-t"),
      ));
      if (!this.root) return json({ error: "database has no root yet" }, 503);
      const body = fromJson(await request.json()) as {
        query?: unknown;
        inputs?: unknown[];
        asOf?: number;
        history?: boolean;
        explain?: boolean;
        pull?: { eid: number | string | [string, unknown]; pattern: unknown };
        entity?: number;
      };
      if (!body || (!body.query && !body.pull && typeof body.entity !== "number")) {
        return json({ error: "body must be { query, inputs? } | { pull } | { entity }" }, 400);
      }
      const basis = makeBasis(dbName, this.root, this.entries);
      const before = { ...this.store.stats };
      const db = await dbFromBasis(this.store, basis, {
        ...(typeof body.asOf === "number" ? { asOf: body.asOf } : {}),
        history: body.history === true,
      });
      this.stats.queries++;
      const headers = () => ({
        "x-ramose-basis-t": String(basis.t),
        "x-ramose-r2-gets": String(this.store.stats.r2Gets - before.r2Gets),
        "x-ramose-cache-hits": String(
          this.store.stats.cacheHits +
          this.store.stats.tierHits +
          this.store.stats.memHits -
          before.cacheHits -
          before.tierHits -
          before.memHits,
        ),
      });
      if (typeof body.entity === "number") {
        return json({ t: basis.t, entity: await db.entity(body.entity) }, 200, headers());
      }
      if (body.pull) {
        const eid = typeof body.pull.eid === "number"
          ? body.pull.eid
          : await db.entid(body.pull.eid as any);
        return eid === undefined
          ? json({ t: basis.t, result: null }, 200, headers())
          : json({
              t: basis.t,
              result: await runPull(db, eid, body.pull.pattern as any),
            }, 200, headers());
      }
      const stats: QueryStats = { clauses: [] };
      const result = await runQuery(db, body.query as any, body.inputs ?? [], {
        stats,
        maxCells: envInt(
          this.env.RAMOSE_QUERY_MAX_CELLS,
          DEFAULT_QUERY_MAX_CELLS,
        ),
      });
      if (this.stats.queries % 100 === 1) {
        this.log.debug("replica.query", {
          db: this.dbName,
          t: basis.t,
          rows: Array.isArray(result) ? result.length : 1,
          novelty: this.entries.length,
          peakCells: stats.budget?.peakCells,
        });
      }
      return json({
        t: basis.t,
        root: basis.root.t,
        result,
        ...(body.explain ? { explain: stats.clauses, budget: stats.budget } : {}),
      }, 200, headers());
    }
    if (url.pathname === "/info") {
      return json({
        db: this.dbName,
        t: this.basisT,
        root: this.root,
        novelty: this.entries.length,
        connected: this.ws?.readyState === 1,
        stats: this.stats,
        store: this.store.stats,
      });
    }
    if (url.pathname === "/admin/test/sessions") {
      const sessions = (this.ctx.getWebSockets() as WebSocket[])
        .filter((ws) => this.basisWatchOf(ws) === undefined)
        .map((ws) => this.sessionOf(ws).state());
      return json({ ok: true, sessions });
    }
    if (
      url.pathname === "/admin/test/checkpoint" ||
      url.pathname === "/admin/test/abort"
    ) {
      return (await testing.handleAdmin(
        request,
        url.pathname,
        (reason) => this.ctx.abort(reason),
      )) ?? json({ error: "not found" }, 404);
    }
    if (url.pathname === "/admin/reconnect") {
      this.closeBasisWatches("upstream reconnecting");
      try {
        this.ws?.close(1000, "reconnect");
      } catch {
        /* already gone */
      }
      this.ws = undefined;
      await this.sync();
      return json({ ok: true, t: this.basisT });
    }
    return super.route(request, url, dbName);
  }
};
