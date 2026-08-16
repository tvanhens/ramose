/**
 * The session socket: one client WebSocket, multiplexed over the Worker's own
 * HTTP routes.
 *
 * `GET /db/:name/session` (Upgrade) is accepted by the Worker itself — no new
 * Durable Object, no session id, no hibernation. The socket lives with the
 * request; when the isolate dies the client reconnects. The Worker sees every
 * frame: each one is planned here (`planOf`) and dispatched back into the same
 * `/transact` | `/query` | `/pull` | `/entity` | `/info` handlers curl hits, so
 * there is exactly one implementation of a read and one of a write.
 *
 *   client → { id, op: "transact" | "q" | "pull" | "entity" | "info", … }
 *   server → { id, status, body, headers? }        one reply per frame
 *   server → { op: "t", t }                        unsolicited: basis moved
 *
 * `t` frames come from two places, both cheap and both isolate-local:
 *   - ack.t: a write on this socket answered with `{ t }` (sent after its reply)
 *   - polling: this isolate's `GET /basis` watcher for `db|hint`, shared by
 *     every session on the same key and refcounted down to zero
 * A session only ever sees `t` go forwards (`lastT`), so a client can use the
 * last one it saw as `x-ripple-min-t` on the next read.
 *
 * This module deliberately imports nothing from `cloudflare:workers`: the
 * socket, the dispatcher and the timer are injected (`SocketLike`,
 * `SessionDispatch`, `Scheduler`), so the whole protocol is testable under
 * `bun test` while index.ts supplies the real `WebSocketPair` and `route()`.
 *
 * Payloads are opaque: frames carry the same JSON the HTTP routes already
 * accept (`toJson`-encoded values), and this module never decodes them.
 */

// ---- wire ------------------------------------------------------------------

/** A frame from the client. `id` correlates the reply; ops mirror the HTTP routes. */
export type ClientFrame =
  | { id: number; op: "transact"; tx: unknown[] }
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

/** Unsolicited: the basis this session reads from has moved to `t`. */
export interface TickFrame {
  op: "t";
  t: number;
}

/** Diagnostic response headers worth carrying back on a reply (the `x-ripple-*` set the routes set). */
export const META_HEADERS: readonly string[] = [
  "x-ripple-ms",
  "x-ripple-r2-gets",
  "x-ripple-cache-hits",
  "x-ripple-basis-t",
  "x-ripple-basis-hit",
  "x-ripple-basis-reason",
  "x-ripple-basis-calls",
  "x-ripple-basis-behind",
  "x-ripple-replica-hint",
  "x-ripple-cache-basis",
  "x-ripple-cache-mode",
  "x-ripple-colo",
];

// ---- seams -----------------------------------------------------------------

/** The bits of a `WebSocket` a session uses (a Workers server socket after `accept()`). */
export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message" | "close" | "error", cb: (ev: any) => void): void;
}

/** Runs one planned frame against the Worker's own routes; never rejects for a non-2xx. */
export type SessionDispatch = (rest: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<Response>;

/** `setInterval`-shaped; returns its own cancel. */
export type Scheduler = (fn: () => void, ms: number) => () => void;

export interface SessionOptions {
  dispatch: SessionDispatch;
  /** reads the current basis `t` (isolate-local, cache-bypassing) — omit to disable polling */
  pollBasis?: () => Promise<number>;
  /** sessions sharing this key share one poller (the read path's `db|hint`) */
  watchKey?: string;
  pollIntervalMs?: number;
  schedule?: Scheduler;
}

export interface Session {
  /** Handle one inbound frame. Never rejects; concurrent calls are fine (frames are not serialized). */
  onMessage(data: string | ArrayBuffer): Promise<void>;
  /** Send `{ op: "t", t }` if this is news to this socket. */
  notifyT(t: number): void;
  close(): void;
  /** Highest `t` this socket has been told about. */
  readonly lastT: number;
  /** Resolves when the socket is closed or errors (index.ts holds the request open with it). */
  readonly closed: Promise<void>;
}

export const DEFAULT_POLL_INTERVAL_MS = 1_000;

const defaultSchedule: Scheduler = (fn, ms) => {
  const handle = setInterval(fn, ms);
  return () => clearInterval(handle as unknown as number);
};

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

/** `x-ripple-min-t` when the caller carries a fence, nothing otherwise. */
const minTHeader = (v: unknown): Record<string, string> =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? { "x-ripple-min-t": String(v) } : {};

const isPlanError = (p: SessionPlan | PlanError): p is PlanError => (p as PlanError).error !== undefined;

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
      return { id, op: "transact", rest: "/transact", method: "POST", headers: { ...JSON_CT }, body: JSON.stringify({ tx: f.tx }) };
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

// ---- basis watchers (one per db|hint per isolate, refcounted) ---------------

interface Watcher {
  readonly subs: Set<(t: number) => void>;
  cancel: () => void;
  /** last basis `t` this watcher observed */
  t: number;
  /** the first poll only seeds `t` — a watcher reports movement, not the current value */
  seeded: boolean;
  /** a poll is in flight; overlapping ticks are dropped rather than queued */
  inflight: boolean;
}

const watchers = new Map<string, Watcher>();

/** Test hook: the live watcher keys (a session that closed must not leave one behind). */
export function watcherKeys(): string[] {
  return [...watchers.keys()];
}

async function tick(key: string, w: Watcher, poll: () => Promise<number>): Promise<void> {
  if (w.inflight) return;
  w.inflight = true;
  try {
    const t = await poll();
    if (watchers.get(key) !== w) return; // unsubscribed while the poll was in flight
    if (typeof t !== "number" || !Number.isFinite(t)) return;
    if (!w.seeded) {
      w.seeded = true;
      w.t = t;
      return;
    }
    if (t <= w.t) return;
    w.t = t;
    for (const cb of [...w.subs]) {
      try {
        cb(t);
      } catch {
        /* one dead socket must not stop the fan-out */
      }
    }
  } catch {
    /* a transient replica error just means no news this tick */
  } finally {
    w.inflight = false;
  }
}

/** Join (or start) the watcher for `key`; the returned unsubscribe stops it when the last session leaves. */
function subscribe(key: string, poll: () => Promise<number>, intervalMs: number, schedule: Scheduler, cb: (t: number) => void): () => void {
  let w = watchers.get(key);
  if (!w) {
    w = { subs: new Set(), cancel: () => {}, t: 0, seeded: false, inflight: false };
    watchers.set(key, w);
    const entry = w;
    entry.cancel = schedule(() => void tick(key, entry, poll), intervalMs);
  }
  const entry = w;
  entry.subs.add(cb);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    entry.subs.delete(cb);
    if (entry.subs.size === 0 && watchers.get(key) === entry) {
      watchers.delete(key);
      entry.cancel();
    }
  };
}

// ---- the session ------------------------------------------------------------

/** Wire an accepted socket to the Worker's routes. Returns the session (also driven by the socket's own events). */
export function openSession(socket: SocketLike, options: SessionOptions): Session {
  let lastT = 0;
  let dead = false;
  let unsubscribe: (() => void) | undefined;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const die = () => {
    if (dead) return;
    dead = true;
    unsubscribe?.();
    unsubscribe = undefined;
    resolveClosed();
  };

  const send = (frame: ReplyFrame | TickFrame) => {
    if (dead) return;
    try {
      socket.send(JSON.stringify(frame));
    } catch {
      die(); // the socket went away between the check and the send
    }
  };

  const notifyT = (t: number) => {
    if (dead || typeof t !== "number" || !Number.isFinite(t) || t <= lastT) return;
    lastT = t;
    send({ op: "t", t });
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
    const plan = planOf(frame);
    if (isPlanError(plan)) {
      send({ id: plan.id ?? 0, status: 400, body: { error: plan.error } });
      return;
    }
    let res: Response;
    try {
      res = await options.dispatch(plan.rest, { method: plan.method, headers: plan.headers, body: plan.body });
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
    // ack.t: a write on this socket is the cheapest possible basis notification — after its reply
    if (plan.op === "transact" && res.ok) {
      const t = (body as { t?: unknown } | null)?.t;
      if (typeof t === "number") notifyT(t);
    }
  };

  socket.addEventListener("message", (ev: { data: string | ArrayBuffer }) => void onMessage(ev.data));
  socket.addEventListener("close", die);
  socket.addEventListener("error", die);

  if (options.pollBasis && options.watchKey !== undefined) {
    unsubscribe = subscribe(options.watchKey, options.pollBasis, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, options.schedule ?? defaultSchedule, notifyT);
  }

  return {
    onMessage,
    notifyT,
    close() {
      const wasDead = dead;
      die();
      if (!wasDead) socket.close();
    },
    get lastT() {
      return lastT;
    },
    closed,
  };
}
