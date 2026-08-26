/** Session socket protocol: inbound frames + the apply-then-push walk. */

import type { Principal, WireDatom } from "../internal/core/index.ts";
import type { WritesMode } from "../writes.ts";
import { WRITES_HEADER } from "../writes.ts";
import type { SessionLog, SessionLogEntry, SessionTxDecision } from "./session-sync.ts";

export { WRITES_HEADER };

// ---- wire ------------------------------------------------------------------

/** A frame from the client. `id` correlates the reply; ops mirror the HTTP routes. */
export type ClientFrame =
  /** token refresh — the only frame that is not a sub-request */
  | { id: number; op: "auth"; token: string }
  | { id: number; op: "transact"; tx: unknown[]; clientTxId?: string }
  | { id: number; op: "operation"; name: string; entity?: unknown; input: unknown; clientOpId?: string }
  /** catch-up: walk `(from, now]` and skip empties; resync if the gap is gone or a rule view flipped */
  | { id: number; op: "sync"; from: number }
  | { id: number; op: "q"; query: string | object; inputs?: unknown[]; asOf?: number; history?: boolean; explain?: boolean; minT?: number }
  | { id: number; op: "pull"; eid: number | string | [string, unknown]; pattern: string | unknown[]; asOf?: number; history?: boolean; minT?: number }
  | { id: number; op: "entity"; eid: number; asOf?: number }
  | { id: number; op: "info" };

/** One reply per client frame. `id` is 0 when the frame was too malformed to carry one. */
export interface ReplyFrame {
  id: number;
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** Who a session is, as the wire tells it: `eid` is `null` only when the peer does not provision this principal. */
export interface WirePrincipal {
  eid: number | null;
  class: string;
}

/** The `auth` frame's success reply: the principal was swapped (and, when the session can describe it, who it now is). */
export interface AuthAck {
  id: number;
  ok: true;
  principal?: WirePrincipal;
}

/** Unsolicited: facts this principal may read from one committed tx. */
export interface TxPushFrame {
  op: "tx";
  t: number;
  datoms: WireDatom[];
  /** Writer's own echo only — the session that POSTed this tx. */
  clientTxId?: string;
}

/** Unsolicited: this principal's rule view flipped — drop local state and sieve current. */
export interface ResyncFrame {
  op: "resync";
  t: number;
  datoms?: WireDatom[];
}

/** Diagnostic response headers worth carrying back on a reply (the `x-ramose-*` set the routes set). */
export const META_HEADERS: readonly string[] = [
  "x-ramose-ms",
  "x-ramose-r2-gets",
  "x-ramose-cache-hits",
  "x-ramose-basis-t",
  "x-ramose-basis-hit",
  "x-ramose-basis-reason",
  "x-ramose-basis-calls",
  "x-ramose-basis-behind",
  "x-ramose-replica-hint",
  "x-ramose-cache-basis",
  "x-ramose-cache-mode",
  "x-ramose-colo",
];

/** Worker→replica upgrade: the verified principal, so the replica does not re-parse the JWT. */
export const PRINCIPAL_HEADER = "x-ramose-principal";

// ---- seams -----------------------------------------------------------------

/** The bits of a `WebSocket` a session uses (a Workers / DO server socket). */
export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message" | "close" | "error", cb: (ev: any) => void): void;
}

/** Runs one planned frame against HTTP routes; never rejects for a non-2xx. */
export type SessionDispatch = (rest: string, init: { method: string; headers: Record<string, string>; body?: string }, principal?: Principal) => Promise<Response>;

/** Hibernation attachment / reconstruct seed. */
export interface SessionState {
  readonly principal?: Principal;
  readonly lastT: number;
  readonly watermark: number;
  readonly writerEcho?: { t: number; clientTxId: string };
  /** Resolved write mode from the Worker upgrade (`x-ramose-writes`). */
  readonly writes?: WritesMode;
}

export interface SessionOptions {
  dispatch: SessionDispatch;
  /** the principal from the upgrade (`?token=` / `Authorization`) */
  principal?: Principal;
  /** re-verify a token for this same database; rejects when it is refused */
  authenticate?: (token: string) => Promise<Principal>;
  /** `{ eid, class }` for the `auth` ack — the swapped principal's entity, `null` when the peer does not provision this principal */
  describe?: (principal: Principal) => Promise<WirePrincipal>;
  /** peer-owned upsert before the `auth` ack, so the swapped principal has an eid */
  provision?: (principal: Principal) => Promise<Principal>;
  /**
   * Novelty since the current root — used by `{ op: "sync" }` only.
   * Follow is apply-then-push ({@link Session.applyEntry}), not a poller.
   */
  readLog?: () => Promise<SessionLog>;
  /** sieve one unfiltered log entry for this socket's current principal */
  filterEntry?: (entry: SessionLogEntry, principal?: Principal) => Promise<SessionTxDecision>;
  /** current-value dump through the read view — first sync / resync */
  snapshot?: (principal?: Principal) => Promise<{ t: number; datoms: WireDatom[] }>;
  /** restore after hibernation */
  seed?: SessionState;
  /**
   * When false, the caller drives {@link Session.onMessage} (hibernating DO
   * `webSocketMessage`). Default true for tests / a Worker-accepted socket.
   */
  listen?: boolean;
}

export interface Session {
  /** Handle one inbound frame. Never rejects; concurrent calls are fine (frames are not serialized). */
  onMessage(data: string | ArrayBuffer): Promise<void>;
  /**
   * Replica apply: walk this one applied frame. The follow cursor is the
   * walked `t` (and the replica's `basisT` after apply). Never stamps a tip
   * that was not applied. Overlapping calls must not snapshot `watermark`
   * at enqueue — each job starts from the cursor as it is when it runs.
   */
  applyEntry(entry: SessionLogEntry, rootT: number): Promise<void>;
  close(): void;
  /** Highest `t` this socket has been told about (does not advance on a skipped empty). */
  readonly lastT: number;
  /**
   * Follow cursor: last `t` this session has **walked** (including sieved
   * skips). Advances only by walking applied novelty in `t` order, or to a
   * snapshot's `t` after a dump. Never jumps to a log tip without that dump.
   */
  readonly watermark: number;
  /** Current principal (upgrade or last successful `auth`). */
  readonly principal: Principal | undefined;
  /** Persist across DO hibernation. */
  state(): SessionState;
  /** Resolves when the socket is closed or errors. */
  readonly closed: Promise<void>;
}

// ---- planning --------------------------------------------------------------

/** A frame, resolved to the sub-request that answers it. */
export interface SessionPlan {
  id: number;
  op: ClientFrame["op"];
  /** path under `/db/:name` — may carry a query string (`/entity/7?asOf=3`) */
  rest: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** A frame that could not be planned; answered with a 400 reply (the socket stays open). */
export interface PlanError {
  id: number | undefined;
  error: string;
}

const JSON_CT = { "content-type": "application/json" };

/** `x-ramose-min-t` when the caller carries a fence, nothing otherwise. */
const minTHeader = (v: unknown): Record<string, string> =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? { "x-ramose-min-t": String(v) } : {};

const isPlanError = (p: SessionPlan | PlanError): p is PlanError => (p as PlanError).error !== undefined;

/** Past `exp`: every frame is denied and the socket closes on the next tick. */
const expired = (p: Principal): boolean => p.claims.exp !== undefined && p.claims.exp * 1000 <= Date.now();

/**
 * Frame → sub-request. Pure, and the only place the wire ops map onto routes.
 * Payloads are re-serialized verbatim: whatever encoding the client used for
 * `tx`/`query`/`pattern` is what the route's own `fromJson` sees.
 */
export function planOf(frame: unknown): SessionPlan | PlanError {
  if (typeof frame !== "object" || frame === null || Array.isArray(frame)) return { id: undefined, error: "frame must be an object" };
  const f = frame as Record<string, unknown>;
  if (typeof f.id !== "number" || !Number.isFinite(f.id)) return { id: undefined, error: "frame.id must be a number" };
  const id = f.id;
  switch (f.op) {
    case "transact": {
      if (!Array.isArray(f.tx)) return { id, error: "transact frame needs tx: unknown[]" };
      const body: Record<string, unknown> = { tx: f.tx };
      if (typeof f.clientTxId === "string" && f.clientTxId.length > 0) body.clientTxId = f.clientTxId;
      return { id, op: "transact", rest: "/transact", method: "POST", headers: { ...JSON_CT }, body: JSON.stringify(body) };
    }
    case "operation": {
      if (typeof f.name !== "string" || f.name.length === 0) return { id, error: "operation frame needs name" };
      const body: Record<string, unknown> = { name: f.name, input: f.input };
      if (f.entity !== undefined) body.entity = f.entity;
      if (typeof f.clientOpId === "string" && f.clientOpId.length > 0) body.clientOpId = f.clientOpId;
      return { id, op: "operation", rest: "/op", method: "POST", headers: { ...JSON_CT }, body: JSON.stringify(body) };
    }
    case "q": {
      if (f.query === undefined || f.query === null) return { id, error: "q frame needs query" };
      if (f.inputs !== undefined && !Array.isArray(f.inputs)) return { id, error: "q frame inputs must be an array" };
      const body: Record<string, unknown> = { query: f.query };
      if (f.inputs !== undefined) body.inputs = f.inputs;
      if (typeof f.asOf === "number") body.asOf = f.asOf;
      if (f.history !== undefined) body.history = !!f.history;
      if (f.explain !== undefined) body.explain = !!f.explain;
      return { id, op: "q", rest: "/query", method: "POST", headers: { ...JSON_CT, ...minTHeader(f.minT) }, body: JSON.stringify(body) };
    }
    case "pull": {
      if (f.eid === undefined || f.eid === null) return { id, error: "pull frame needs eid" };
      if (f.pattern === undefined || f.pattern === null) return { id, error: "pull frame needs pattern" };
      const body: Record<string, unknown> = { eid: f.eid, pattern: f.pattern };
      if (typeof f.asOf === "number") body.asOf = f.asOf;
      if (f.history !== undefined) body.history = !!f.history;
      return { id, op: "pull", rest: "/pull", method: "POST", headers: { ...JSON_CT, ...minTHeader(f.minT) }, body: JSON.stringify(body) };
    }
    case "entity": {
      if (typeof f.eid !== "number" || !Number.isInteger(f.eid) || f.eid < 0) return { id, error: "entity frame needs eid: number" };
      const asOf = typeof f.asOf === "number" ? `?asOf=${encodeURIComponent(String(f.asOf))}` : "";
      return { id, op: "entity", rest: `/entity/${f.eid}${asOf}`, method: "GET", headers: {} };
    }
    case "info":
      return { id, op: "info", rest: "/info", method: "GET", headers: {} };
    default:
      return { id, error: `unknown op: ${typeof f.op === "string" ? f.op : String(f.op)}` };
  }
}

export function parsePrincipalHeader(raw: string | null): Principal | undefined {
  if (raw === null || raw === "") return undefined;
  try {
    const p = JSON.parse(raw) as Principal;
    if (typeof p !== "object" || p === null || typeof p.class !== "string" || typeof p.db !== "string") return undefined;
    return p;
  } catch {
    return undefined;
  }
}

// ---- the session ------------------------------------------------------------

/**
 * Wire an accepted socket to dispatch + the apply-then-push walk.
 * The replica is the thing that applies the log and the thing that notifies.
 */
export function openSession(socket: SocketLike, options: SessionOptions): Session {
  const seed = options.seed;
  let lastT = seed?.lastT ?? 0;
  /** last `t` considered, including skipped empties — must not leak via `lastT` */
  let watermark = seed?.watermark ?? 0;
  let dead = false;
  let principal = seed?.principal ?? options.principal;
  /** This socket's last committed write — attached only to that `t`'s `{ op: "tx" }`. */
  let writerEcho: { t: number; clientTxId: string } | undefined = seed?.writerEcho;
  let expiring = false;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const die = () => {
    if (dead) return;
    dead = true;
    resolveClosed();
  };

  const shutdown = () => {
    const wasDead = dead;
    die();
    if (!wasDead) socket.close(1008, "unauthorized");
  };

  const send = (frame: ReplyFrame | TxPushFrame | ResyncFrame | AuthAck) => {
    if (dead) return;
    try {
      socket.send(JSON.stringify(frame));
    } catch {
      // the socket went away between the check and the send, or the runtime
      // refused the write — never leave a zombie: close so the client sees the
      // session end and reconnects instead of waiting forever on dropped frames
      die();
      try {
        socket.close(1011, "session send failed");
      } catch {
        /* already gone */
      }
    }
  };

  /** This socket has been told about `t` (a visible tx / resync). Skips stay silence. */
  const seenT = (t: number): void => {
    if (typeof t === "number" && Number.isFinite(t) && t > lastT) lastT = t;
  };

  const pushResync = async (t: number): Promise<void> => {
    if (options.snapshot) {
      const snap = await options.snapshot(principal);
      send({ op: "resync", t: snap.t, datoms: snap.datoms });
      seenT(snap.t);
      // dump in hand — the cursor may sit at the snapshot's t, not a guessed tip
      watermark = snap.t;
      return;
    }
    send({ op: "resync", t });
    seenT(t);
    watermark = t;
  };

  /**
   * Walk applied novelty in `t` order from `from`. A sieved skip is silence
   * (watermark moves, no `t` leak). A missing `t` in `(from, log.t]` with
   * `t > rootT` is a torn window — dump if we have a snapshot, otherwise hold
   * the cursor. Never jump the cursor to `log.t` and later `continue` a
   * late-appearing visible `t`.
   */
  const consider = async (log: SessionLog, from: number): Promise<void> => {
    if (dead) return;
    if (from < log.rootT) {
      await pushResync(log.t);
      return;
    }
    const filter = options.filterEntry;
    if (!filter) {
      for (const e of log.entries) {
        if (e.t <= from) continue;
        if (e.t > from + 1 && e.t > log.rootT) {
          if (options.snapshot) await pushResync(log.t);
          return;
        }
        watermark = e.t;
        send({ op: "tx", t: e.t, datoms: e.datoms });
        seenT(e.t);
        from = e.t;
      }
      return;
    }
    const pending = log.entries.filter((e) => e.t > from).sort((a, b) => a.t - b.t);
    let cursor = from;
    const torn = async (): Promise<void> => {
      // replica apply is dense, so a hole here is a test / catch-up tear.
      // A snapshot dump is honest. Without one, hold the cursor.
      if (options.snapshot) await pushResync(log.t);
    };
    for (const e of pending) {
      if (e.t > cursor + 1) {
        await torn();
        return;
      }
      const decision = await filter(e, principal);
      if (decision.kind === "skip") {
        cursor = e.t;
        watermark = e.t;
        continue;
      }
      if (decision.kind === "resync") {
        await pushResync(e.t);
        return;
      }
      // `kind: "tx"` without `datoms` is a sieve bug. Never send the replica
      // entry — that is the unfiltered log.
      if (decision.datoms === undefined) throw new Error("session filter returned tx without datoms");
      cursor = e.t;
      watermark = e.t;
      const echo =
        writerEcho !== undefined && writerEcho.t === e.t ? writerEcho.clientTxId : undefined;
      if (echo !== undefined) writerEcho = undefined;
      send({
        op: "tx",
        t: e.t,
        datoms: decision.datoms,
        ...(echo !== undefined ? { clientTxId: echo } : {}),
      });
      seenT(e.t);
    }
    if (cursor < log.t) await torn();
  };

  const failSieve = (): void => {
    if (dead) return;
    die();
    try {
      socket.close(1011, "session filter failed");
    } catch {
      /* already gone */
    }
  };

  let considering: Promise<void> = Promise.resolve();
  /**
   * Walk the log from the cursor as it is when this job *runs*. Capturing
   * `watermark` at enqueue lets two overlapping `applyEntry`s share the
   * same `from`; the later `t` then looks torn and never sends `{ op: tx }`.
   */
  const enqueueConsider = (log: SessionLog): Promise<void> => {
    const run = considering.then(() => consider(log, watermark));
    considering = run.catch(() => undefined);
    return run;
  };

  const applyEntry = (entry: SessionLogEntry, rootT: number): Promise<void> =>
    enqueueConsider({ t: entry.t, rootT, entries: [entry] }).catch((err) => {
      failSieve();
      throw err;
    });

  /** `{op:"auth", token}`: re-verify, then swap. A refusal keeps the old principal. */
  const refresh = async (f: Record<string, unknown>): Promise<void> => {
    const id = typeof f.id === "number" && Number.isFinite(f.id) ? f.id : 0;
    if (!options.authenticate) {
      send({ id, status: 400, body: { error: "this session cannot re-authenticate" } });
      return;
    }
    try {
      principal = await options.authenticate(typeof f.token === "string" ? f.token : "");
      if (options.provision !== undefined) {
        try {
          principal = await options.provision(principal);
        } catch {
          // a transient writer error must not fail the swap; describe may still resolve
        }
      }
      let who: WirePrincipal | undefined;
      if (options.describe !== undefined) {
        try {
          who = await options.describe(principal);
        } catch {
          // a transient replica error must not fail the swap; the ack just cannot name the entity
          who = { eid: null, class: principal.class };
        }
      }
      send({ id, ok: true, ...(who === undefined ? {} : { principal: who }) });
    } catch (err) {
      const e = err as { status?: number; code?: string; message?: string };
      send({ id, status: typeof e?.status === "number" ? e.status : 401, body: { error: e?.message || "unauthorized", ...(typeof e?.code === "string" ? { code: e.code } : {}) } });
    }
  };

  const onMessage = async (data: string | ArrayBuffer): Promise<void> => {
    if (dead) return;
    let frame: unknown;
    try {
      frame = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data));
    } catch {
      send({ id: 0, status: 400, body: { error: "frame must be JSON" } });
      return;
    }
    if (typeof frame === "object" && frame !== null && (frame as { op?: unknown }).op === "auth") {
      return refresh(frame as Record<string, unknown>);
    }
    if (typeof frame === "object" && frame !== null && (frame as { op?: unknown }).op === "sync") {
      const f = frame as Record<string, unknown>;
      const id = typeof f.id === "number" && Number.isFinite(f.id) ? f.id : 0;
      const from = typeof f.from === "number" && Number.isFinite(f.from) && f.from >= 0 ? f.from : 0;
      if (!options.readLog) {
        send({ id, status: 400, body: { error: "this session cannot sync a log" } });
        return;
      }
      try {
        const log = await options.readLog();
        watermark = from;
        await enqueueConsider(log);
        // walk cursor, not log tip — a torn window must not claim log.t
        send({ id, status: 200, body: { t: watermark, from } });
      } catch (err) {
        send({ id, status: 500, body: { error: err instanceof Error ? err.message : String(err) } });
        failSieve();
      }
      return;
    }
    const plan = planOf(frame);
    if (isPlanError(plan)) {
      send({ id: plan.id ?? 0, status: 400, body: { error: plan.error } });
      return;
    }
    // the principal is bound at plan time: frames planned after an `auth` ack use
    // the new one, in-flight ones finish under the old
    const bound = principal;
    if (bound !== undefined && expired(bound)) {
      send({ id: plan.id, status: 401, body: { error: "token expired" } });
      if (!expiring) {
        expiring = true;
        setTimeout(shutdown, 0);
      }
      return;
    }
    let res: Response;
    try {
      res = await options.dispatch(plan.rest, { method: plan.method, headers: plan.headers, body: plan.body }, bound);
    } catch (err) {
      send({ id: plan.id, status: 500, body: { error: err instanceof Error ? err.message : String(err) } });
      return;
    }
    let body: unknown;
    try {
      const text = await res.text();
      try {
        body = JSON.parse(text);
      } catch {
        body = text; // an upstream pass-through that was never JSON
      }
    } catch (err) {
      send({ id: plan.id, status: 500, body: { error: err instanceof Error ? err.message : String(err) } });
      return;
    }
    const headers: Record<string, string> = {};
    for (const h of META_HEADERS) {
      const v = res.headers.get(h);
      if (v !== null) headers[h] = v;
    }
    send({ id: plan.id, status: res.status, body, ...(Object.keys(headers).length > 0 ? { headers } : {}) });
    // HTTP ack paints the writer overlay. It does not move the follow cursor —
    // that moves when the replica applies this t and walks the socket.
    if ((plan.op === "transact" || plan.op === "operation") && res.ok) {
      const ack = body as { t?: unknown; clientTxId?: unknown; clientOpId?: unknown } | null;
      const echoT = typeof ack?.t === "number" ? ack.t : undefined;
      let echoId =
        typeof ack?.clientTxId === "string" && ack.clientTxId.length > 0
          ? ack.clientTxId
          : typeof ack?.clientOpId === "string" && ack.clientOpId.length > 0
            ? ack.clientOpId
            : undefined;
      if (echoId === undefined && plan.body !== undefined) {
        try {
          const req = JSON.parse(plan.body) as { clientTxId?: unknown; clientOpId?: unknown };
          if (typeof req.clientTxId === "string" && req.clientTxId.length > 0) echoId = req.clientTxId;
          else if (typeof req.clientOpId === "string" && req.clientOpId.length > 0) echoId = req.clientOpId;
        } catch {
          /* body was not JSON — no client id to echo */
        }
      }
      if (echoT !== undefined && echoId !== undefined) writerEcho = { t: echoT, clientTxId: echoId };
    }
  };

  if (options.listen !== false) {
    socket.addEventListener("message", (ev: { data: string | ArrayBuffer }) => void onMessage(ev.data));
    socket.addEventListener("close", die);
    socket.addEventListener("error", die);
  }

  return {
    onMessage,
    applyEntry,
    close() {
      const wasDead = dead;
      die();
      if (!wasDead) socket.close();
    },
    get lastT() {
      return lastT;
    },
    get watermark() {
      return watermark;
    },
    get principal() {
      return principal;
    },
    state: () => ({
      ...(principal !== undefined ? { principal } : {}),
      lastT,
      watermark,
      ...(writerEcho !== undefined ? { writerEcho } : {}),
      ...(seed?.writes !== undefined ? { writes: seed.writes } : {}),
    }),
    closed,
  };
}

/** After the replica applies one dense `t`, walk every attached session. */
export async function pushApplied(sessions: Iterable<Session>, entry: SessionLogEntry, rootT: number): Promise<void> {
  for (const s of sessions) await s.applyEntry(entry, rootT);
}
