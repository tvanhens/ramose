/**
 * @internal One reconnecting WebSocket to `GET /db/:name/session`.
 *
 * The client speaks exactly one socket route (`GET /db/:name/session`). The
 * Worker verifies the caller and upgrades onto the replica that session
 * already queries — no Durable Object is reachable or nameable from here.
 * Reads (`q`, `pull`) and unsolicited `{ op: "tx" }` / `{ op: "resync" }`
 * frames ride it. A visible commit is one frame: `{ op: "tx", t, datoms }`
 * — that `t` is the basis bump, same as a read reply. Writes never ride
 * the socket (`transact` is HTTPS, so `processTx` is untouched).
 *
 * Unlike the socket this replaces, a drop is **not** terminal. The socket is
 * opened lazily by the first read, and after a close / error the next request
 * opens a fresh one — re-reading the token, because a token is
 * `Effect<Redacted<string>>` and is re-read on every (re)connect. A standing
 * `db.live` therefore survives the network: it is woken by
 * {@link Session.onWake} on paint (`nudge`) and on a drop, and its next
 * pass reconnects.
 *
 * `Unauthorized` is handled in place: the frame's 401/403 makes the session
 * re-read the token, send `{ op: "auth", token }` on the *same* socket, and
 * re-issue the frame once. Nothing standing is torn down by that swap — which
 * is the whole point of the peer having an `auth` op.
 *
 * A handshake that never opens is different. The browser (and this
 * `WebSocketLike` seam) hide the upgrade's HTTP status, so a close/error
 * before `open` would otherwise become `SocketGone` → `NetworkError`. When
 * {@link SessionOptions.classifyHandshake} is set, the session asks it with
 * the handshake's token before surfacing that; a 401/403 probe becomes the
 * same tagged `Unauthorized` the HTTP path uses. True transport failures
 * stay `SocketGone`.
 */

import * as Redacted from "effect/Redacted";
import { trimSlashes } from "./http.ts";

/**
 * The slice of `WebSocket` a session uses — so a test can hand in a fake, and
 * so this file does not depend on whose `WebSocket` global is in scope.
 */
export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(
    type: "message" | "open" | "close" | "error",
    cb: (ev: any) => void,
  ): void;
  /** `1` is OPEN. Absent (a fake) is treated as already open. */
  readonly readyState?: number;
}

/** How a session obtains its socket. `layer` defaults it to the global `WebSocket`. */
export type SocketFactory = (url: string) => WebSocketLike;

/** The ambient `WebSocket`, if this runtime has one. */
export const globalWebSocket = (): SocketFactory | undefined =>
  typeof WebSocket === "undefined"
    ? undefined
    : (url: string) => new WebSocket(url) as unknown as WebSocketLike;

/** A reply frame, normalized: an `auth` ack (`{ ok: true }`) is a 200. */
export interface Reply {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Record<string, string> | undefined;
}

/**
 * Who this session is, as the peer's `auth` ack reports it: the principal's
 * entity (`null` when the principal attribute has no row yet) and class.
 */
export interface SessionPrincipal {
  readonly eid: number | null;
  readonly class: string;
}

/** The ack's / `/info` `principal` field, parsed; `undefined` when the peer sent none. */
export const parsePrincipal = (raw: unknown): SessionPrincipal | undefined => {
  if (typeof raw !== "object" || raw === null) return undefined;
  const p = raw as { eid?: unknown; class?: unknown };
  if (typeof p.class !== "string") return undefined;
  return { eid: typeof p.eid === "number" ? p.eid : null, class: p.class };
};

export interface SessionOptions {
  /**
   * Peer base URL — `http(s)://…` is rewritten to `ws(s)://…`. A thunk,
   * because a deploy-time Alchemy Output resolves as an Effect.
   */
  readonly url: () => Promise<string>;
  /** Ramose database name — the `:name` in `/db/:name/session`. */
  readonly name: string;
  /**
   * Re-read on every (re)connect and every re-auth. A rejection is the token
   * source's own failure (a `DbError` from a refreshing mint) and surfaces
   * from `request` untouched.
   */
  readonly token?: (() => Promise<Redacted.Redacted<string> | undefined>) | undefined;
  readonly connect: SocketFactory;
  /**
   * After a handshake that never opened, classify the failure. Return a
   * tagged error (the HTTP path's `Unauthorized`) to surface it; `undefined`
   * keeps `SocketGone`. Receives the token that rode the upgrade — not a
   * fresh mint — so an expired credential is not hidden by a refresh.
   */
  readonly classifyHandshake?:
    | ((token: string | undefined) => Promise<Error | undefined>)
    | undefined;
  /**
   * Unsolicited `{ op: "tx" }` / `{ op: "resync" }` frames. The overlay
   * applies them. Those frames already carry `t` and bump the basis the
   * same way a read reply does.
   */
  readonly onPush?:
    | ((frame: Record<string, unknown>) => void | Promise<void>)
    | undefined;
}

/**
 * What a session (or the client that owns one) reports for "am I connected?".
 *
 * Session itself never returns `"offline"` — that is the client's answer
 * when there is no socket factory, or the browser's `navigator.onLine`
 * is false. A session is `"connecting"` until the first handshake
 * completes, `"live"` while a socket is held, `"reconnecting"` after a
 * drop, and `"closed"` after {@link Session.close}.
 */
export type ConnectionStatus =
  | "connecting"
  | "live"
  | "reconnecting"
  | "offline"
  | "closed";

const STATUS_RANK: Record<ConnectionStatus, number> = {
  live: 0,
  connecting: 1,
  reconnecting: 2,
  offline: 3,
  closed: 4,
};

/** The more concerning of two statuses — used to roll up a multi-db client. */
export const worseConnection = (
  a: ConnectionStatus,
  b: ConnectionStatus,
): ConnectionStatus => (STATUS_RANK[a] >= STATUS_RANK[b] ? a : b);

/** Browser network is gone. Absent `navigator` (Node, Workers) is online. */
export const browserOffline = (): boolean =>
  typeof navigator !== "undefined" && navigator.onLine === false;

export interface Session {
  /** One correlated frame out, its reply back. Reconnects and re-auths as needed. */
  request(frame: Record<string, unknown>): Promise<Reply>;
  /** Highest transaction `t` this session has seen — tx/resync frames, read replies, local writes. */
  readonly t: number;
  /** Bumped on every (re)connect, so a waiter can tell a reconnect from a tick. */
  readonly generation: number;
  /**
   * Derived from {@link generation}, {@link connects}, {@link closed} and
   * whether the current socket completed its handshake. Never `"offline"`.
   */
  readonly status: ConnectionStatus;
  /**
   * The peer's latest word on who this socket is — captured from the `auth`
   * ack of an in-place swap, cleared when the socket drops. `undefined` until
   * an ack carries one (the initial principal rides the upgrade unanswered).
   */
  readonly principal: SessionPrincipal | undefined;
  /** Sockets this session has opened. Test hook. */
  readonly connects: number;
  /** Move the basis (a local `transact` is the cheapest possible notification). */
  bump(t: number): void;
  /**
   * Wake waiters without moving `t` — a pending overlay apply, or an ack
   * that replaced a layer at the same confirmed basis.
   */
  nudge(): void;
  /** Bumped by {@link nudge} (paint), not by a basis bump alone. */
  readonly epoch: number;
  /**
   * Called on a basis bump, a paint nudge, a dropped socket, and a
   * handshake that just became live. Returns the unsubscribe.
   */
  onWake(cb: () => void): () => void;
  /** Overlay registers for `{ op: "tx" }` / `{ op: "resync" }`. */
  onPush(cb: (frame: Record<string, unknown>) => void | Promise<void>): () => void;
  /** Close for good; nothing reopens. */
  close(): void;
  /** `true` once {@link close} ran: every request from here on fails at once. */
  readonly closed: boolean;
}

const OPEN = 1;

const tokenValue = (
  token: Redacted.Redacted<string> | undefined,
): string | undefined => {
  if (token === undefined) return undefined;
  const value = Redacted.value(token);
  return value.length > 0 ? value : undefined;
};

/** `https://peer/…` → `wss://peer/db/:name/session[?token=…]`. */
export const sessionUrl = (
  url: string,
  name: string,
  token?: string | undefined,
): string =>
  `${trimSlashes(url).replace(/^http/, "ws")}/db/${encodeURIComponent(
    name,
  )}/session${token === undefined ? "" : `?token=${encodeURIComponent(token)}`}`;

const asRecord = (value: unknown): Record<string, unknown> =>
  (typeof value === "object" && value !== null ? value : {}) as Record<
    string,
    unknown
  >;

/** The transport failure a socket that went away produces. */
export class SocketGone extends Error {}

export const openSession = (options: SessionOptions): Session => {
  const pending = new Map<
    number,
    { resolve: (r: Reply) => void; reject: (e: unknown) => void }
  >();
  const wakers = new Set<() => void>();
  const pushers = new Set<(frame: Record<string, unknown>) => void | Promise<void>>();

  let socket: WebSocketLike | undefined;
  let opening: Promise<void> | undefined;
  let nextId = 1;
  let basisT = 0;
  let epoch = 0;
  let generation = 0;
  let connects = 0;
  let closed = false;
  let opened = false;
  let everOpened = false;
  let principal: SessionPrincipal | undefined;

  const statusOf = (): ConnectionStatus => {
    if (closed) return "closed";
    if (opened) return "live";
    if (!everOpened) return "connecting";
    return "reconnecting";
  };

  const wake = (): void => {
    // copy: a waker may unsubscribe itself while being notified
    for (const cb of [...wakers]) cb();
  };

  const bump = (value: unknown): void => {
    if (typeof value !== "number" || !Number.isFinite(value)) return;
    if (value <= basisT) return;
    basisT = value;
    wake();
  };

  const nudge = (): void => {
    epoch += 1;
    wake();
  };

  const pushFrame = (frame: Record<string, unknown>): void => {
    const cbs = [...pushers];
    if (options.onPush !== undefined) cbs.unshift(options.onPush);
    for (const cb of cbs) void cb(frame);
  };

  /** This socket is gone. Everything waiting on it fails; the next request reopens. */
  const drop = (message: string): void => {
    if (socket === undefined && pending.size === 0) return;
    socket = undefined;
    opened = false;
    principal = undefined; // the next socket authenticates afresh on its upgrade
    const waiting = [...pending.values()];
    pending.clear();
    for (const p of waiting) p.reject(new SocketGone(message));
    generation += 1;
    wake();
  };

  const onMessage = (ev: { data?: unknown }): void => {
    const data = typeof ev?.data === "string" ? ev.data : undefined;
    if (data === undefined) return;
    let frame: Record<string, unknown>;
    try {
      frame = asRecord(JSON.parse(data));
    } catch {
      return;
    }
    if (typeof frame.id === "number") {
      const p = pending.get(frame.id);
      if (p === undefined) return;
      pending.delete(frame.id);
      bump(asRecord(frame.body).t);
      // an `auth` ack is `{ id, ok: true, principal? }` — no status, and not a
      // refusal; the principal it names supersedes anything read before it
      if (frame.ok === true) {
        const who = parsePrincipal(frame.principal);
        if (who !== undefined) principal = who;
      }
      p.resolve({
        status: typeof frame.status === "number" ? frame.status : 200,
        body: frame.body,
        headers: frame.headers as Record<string, string> | undefined,
      });
      return;
    }
    // One unsolicited op per visible commit: `{ op: tx, t, datoms }` bumps
    // the basis. Overlay apply is the notify (`handlePush` paints then
    // `onChange`); live does not treat this bump as a wake.
    if (frame.op === "tx" || frame.op === "resync") {
      bump(frame.t);
      pushFrame(frame);
    }
  };

  const connect = (): Promise<void> => {
    if (closed) {
      return Promise.reject(new SocketGone("ramose: the client is closed"));
    }
    if (socket !== undefined) return Promise.resolve();
    if (opening !== undefined) return opening;
    const started = (async () => {
      // the token is re-read here: every (re)connect authenticates afresh
      const token = tokenValue(
        options.token === undefined ? undefined : await options.token(),
      );
      const target = sessionUrl(await options.url(), options.name, token);
      // a close that landed while the token/url resolved wins: a socket
      // opened for a closed session would leak, because `close()` has no
      // handle on it yet
      if (closed) throw new SocketGone("ramose: the client is closed");
      const ws = options.connect(target);
      connects += 1;
      let settle!: (e?: unknown) => void;
      const handshake = new Promise<void>((resolve, reject) => {
        settle = (e) => (e === undefined ? resolve() : reject(e));
      });
      let didOpen = false;
      const markOpen = (): void => {
        didOpen = true;
        opened = true;
        everOpened = true;
        settle();
        wake();
      };
      ws.addEventListener("open", markOpen);
      ws.addEventListener("close", () => {
        settle(new SocketGone("ramose: session socket closed"));
        if (socket === ws) drop("ramose: session socket closed");
      });
      ws.addEventListener("error", () => {
        settle(new SocketGone("ramose: session socket failed"));
        if (socket === ws) drop("ramose: session socket failed");
      });
      ws.addEventListener("message", onMessage);
      socket = ws;
      generation += 1;
      if (ws.readyState === undefined || ws.readyState === OPEN) {
        markOpen();
      }
      try {
        await handshake;
      } catch (cause) {
        // the browser socket API does not expose the upgrade status; a
        // probe can recover 401/403. Do not invent a status when it cannot.
        if (!didOpen && !closed && options.classifyHandshake !== undefined) {
          const classified = await options.classifyHandshake(token);
          if (classified !== undefined) throw classified;
        }
        throw cause;
      }
    })();
    const tracked: Promise<void> = started.finally(() => {
      if (opening === tracked) opening = undefined;
    });
    opening = tracked;
    return tracked;
  };

  const dispatch = (frame: Record<string, unknown>): Promise<Reply> => {
    const ws = socket;
    if (ws === undefined) {
      return Promise.reject(new SocketGone("ramose: session socket closed"));
    }
    const id = nextId++;
    return new Promise<Reply>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        ws.send(JSON.stringify({ id, ...frame }));
      } catch (cause) {
        pending.delete(id);
        reject(new SocketGone(String(cause)));
      }
    });
  };

  /** 401/403: re-read the token, swap the principal in place, re-issue once. */
  const reauth = async (): Promise<boolean> => {
    if (options.token === undefined) return false;
    const token = tokenValue(await options.token());
    const ack = await dispatch({ op: "auth", token: token ?? "" });
    return ack.status < 400;
  };

  const request = async (
    frame: Record<string, unknown>,
  ): Promise<Reply> => {
    await connect();
    const reply = await dispatch(frame);
    if (reply.status !== 401 && reply.status !== 403) return reply;
    return (await reauth()) ? dispatch(frame) : reply;
  };

  return {
    request,
    get t() {
      return basisT;
    },
    get epoch() {
      return epoch;
    },
    get generation() {
      return generation;
    },
    get principal() {
      return principal;
    },
    get connects() {
      return connects;
    },
    get closed() {
      return closed;
    },
    get status() {
      return statusOf();
    },
    bump: (t) => bump(t),
    nudge,
    onWake: (cb) => {
      wakers.add(cb);
      return () => {
        wakers.delete(cb);
      };
    },
    onPush: (cb) => {
      pushers.add(cb);
      return () => {
        pushers.delete(cb);
      };
    },
    close: () => {
      if (closed) return;
      closed = true;
      const ws = socket;
      drop("ramose: the client is closed");
      generation += 1;
      wake();
      try {
        ws?.close();
      } catch {
        // closing a socket that never opened is not an error worth raising
      }
    },
  };
};
