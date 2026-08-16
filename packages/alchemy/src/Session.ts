/**
 * The session socket: one WebSocket to `GET /db/:name/session`, worn as a
 * {@link FetchLike}.
 *
 * The clients in `Client.ts` never touch the network themselves — every route
 * they speak goes through the one `fetch` seam on their source. So the socket
 * is not a second client stack: it is a different function passed into the same
 * one. `openSession(...).fetch` takes the request the HTTP client would have
 * made, turns it into a frame (`{ id, op, … }`), and turns the peer's reply
 * frame back into a `Response`. Everything downstream — the `@ripple/core` JSON
 * transport, the `x-ripple-*` meta, the tagged error classification in
 * `DatabaseTypes.ts` — is unchanged, because it only ever sees a `Response`.
 *
 * ```
 *   POST /db/movies/transact  { tx }                → { id, op: "transact", tx }
 *   POST /db/movies/query     { query, inputs, … }  → { id, op: "q",        query, inputs, … }
 *   POST /db/movies/pull      { eid, pattern, … }   → { id, op: "pull",     eid, pattern, … }
 *   GET  /db/movies/entity/17?asOf=42               → { id, op: "entity",   eid: 17, asOf: 42 }
 *   GET  /db/movies/info                            → { id, op: "info" }
 *   reply                                           ← { id, status, body, headers? }
 *   basis moved                                     ← { op: "t", t }
 * ```
 *
 * The `x-ripple-min-t` read fence is a *header* on the HTTP path; a frame has
 * no headers, so it is lifted into the frame's `minT` field. Anything that is
 * not a `/db/:name/…` route for *this* session's database (`/health`, the
 * `/admin/…` routes, another database) falls through to the ordinary `fetch`,
 * which is what keeps the peer-level routes working over one socket.
 *
 * Workers cannot hibernate a socket: this connection lives with the request
 * that opened it, and isolate death drops it. A dropped socket fails every
 * in-flight and subsequent request with `NetworkError` (the promise rejects,
 * which is exactly what `send` in `Client.ts` classifies) — it does not
 * silently fall back to HTTP.
 */

import * as Redacted from "effect/Redacted";
import { globalFetch, type FetchLike } from "./Client.ts";

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
  /** `1` is OPEN. Absent (a fake) is treated as open. */
  readonly readyState?: number;
}

export interface SessionOptions {
  /** Peer base URL — `http(s)://…` is rewritten to `ws(s)://…` (trailing slashes trimmed). */
  readonly url: string;
  /** Ripple database name — the `:name` in `/db/:name/session`. */
  readonly name: string;
  /**
   * The peer's bearer token. A browser cannot set headers on a WebSocket
   * handshake, so it rides the handshake as `?token=…` (the peer accepts both).
   */
  readonly token?: Redacted.Redacted<string> | string | undefined;
  /** Extra headers for whatever still goes over {@link SessionOptions.fetch}. */
  readonly headers?: Record<string, string> | undefined;
  /** Injection seam for the socket itself — defaults to the ambient `WebSocket`. */
  readonly connect?: ((url: string) => WebSocketLike) | undefined;
  /** Where non-session routes (`/health`, `/admin/…`) go — defaults to the ambient `fetch`. */
  readonly fetch?: FetchLike | undefined;
}

export interface Session {
  /** The transport. Drop it into `Client.make({ …, fetch })` or a `SystemSource`. */
  readonly fetch: FetchLike;
  /** Highest transaction `t` this socket has seen — from acks, reads, and `t` frames. */
  readonly t: number;
  /** Subscribe to basis movement. Returns the unsubscribe. */
  onT(cb: (t: number) => void): () => void;
  /** Close the socket; every in-flight request fails with `NetworkError`. */
  close(): void;
}

const OPEN = 1;

const tokenValue = (
  token: Redacted.Redacted<string> | string | undefined,
): string | undefined => {
  if (token === undefined) return undefined;
  const value = typeof token === "string" ? token : Redacted.value(token);
  return value.length > 0 ? value : undefined;
};

/** `https://peer/…` → `wss://peer/db/:name/session[?token=…]`. */
export const sessionUrl = (
  url: string,
  name: string,
  token?: Redacted.Redacted<string> | string | undefined,
): string => {
  const value = tokenValue(token);
  return `${url.replace(/\/+$/, "").replace(/^http/, "ws")}/db/${encodeURIComponent(
    name,
  )}/session${value === undefined ? "" : `?token=${encodeURIComponent(value)}`}`;
};

const defaultConnect = (url: string): WebSocketLike =>
  new WebSocket(url) as unknown as WebSocketLike;

/** Drop `undefined` fields — JSON would otherwise send them as `null`. */
const compact = (o: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out;
};

const record = (value: unknown): Record<string, unknown> =>
  (typeof value === "object" && value !== null ? value : {}) as Record<
    string,
    unknown
  >;

const DB_PATH = /^\/db\/([^/]+)(\/.*)$/;
const ENTITY = /^\/entity\/(\d+)$/;

/** The read fence is a header on the HTTP path and a field on the wire. */
const minTOf = (headers: Record<string, string> | undefined): number | undefined => {
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (k.toLowerCase() !== "x-ripple-min-t") continue;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
};

const bodyOf = (body: string | undefined): Record<string, unknown> => {
  if (body === undefined) return {};
  try {
    return record(JSON.parse(body));
  } catch {
    return {};
  }
};

interface RequestInit_ {
  method: string;
  headers: Record<string, string>;
  body?: string | undefined;
}

/**
 * The request one of this session's frames stands for, or `undefined` when it
 * is not this database's business and belongs on the fallback `fetch`.
 */
const frameOf = (
  name: string,
  url: string,
  init: RequestInit_,
): Record<string, unknown> | undefined => {
  let pathname: string;
  let params: URLSearchParams;
  try {
    // the base only matters if a caller passed a relative url; absolute wins
    const parsed = new URL(url, "http://ripple.invalid");
    pathname = parsed.pathname;
    params = parsed.searchParams;
  } catch {
    return undefined;
  }
  const m = DB_PATH.exec(pathname);
  if (!m || decodeURIComponent(m[1]) !== name) return undefined;
  const rest = m[2];
  const body = bodyOf(init.body);
  const minT = minTOf(init.headers);

  if (rest === "/transact" && init.method === "POST") {
    return { ...body, op: "transact" };
  }
  if (rest === "/query" && init.method === "POST") {
    return compact({ ...body, op: "q", minT });
  }
  if (rest === "/pull" && init.method === "POST") {
    return compact({ ...body, op: "pull", minT });
  }
  if (rest === "/info" && init.method === "GET") return { op: "info" };
  const entity = ENTITY.exec(rest);
  if (entity && init.method === "GET") {
    return compact({
      op: "entity",
      eid: Number(entity[1]),
      asOf: params.has("asOf") ? Number(params.get("asOf")) : undefined,
    });
  }
  return undefined;
};

/** A reply frame, re-materialized as the `Response` the client expects. */
const responseOf = (frame: Record<string, unknown>): Response => {
  const status = typeof frame.status === "number" ? frame.status : 200;
  const bodyless = status < 200 || status === 204 || status === 205 || status === 304;
  return new Response(
    bodyless || frame.body === undefined ? null : JSON.stringify(frame.body),
    {
      status,
      headers: {
        "content-type": "application/json",
        ...record(frame.headers ?? {}),
      } as Record<string, string>,
    },
  );
};

/**
 * Open one session socket for one database.
 *
 * @example
 * ```typescript
 * const session = openSession({ url: "https://peer.example.com", name: "movies", token });
 * const db = Client.make({ url: "https://peer.example.com", name: "movies", fetch: session.fetch });
 * session.onT((t) => console.log("basis moved", t));
 * ```
 */
export const openSession = (options: SessionOptions): Session => {
  const socket = (options.connect ?? defaultConnect)(
    sessionUrl(options.url, options.name, options.token),
  );
  const fallback = options.fetch ?? globalFetch;

  const pending = new Map<
    number,
    { resolve: (r: Response) => void; reject: (e: unknown) => void }
  >();
  const queued: string[] = [];
  const listeners = new Set<(t: number) => void>();
  let nextId = 1;
  let basisT = 0;
  let open = socket.readyState === undefined || socket.readyState === OPEN;
  let dead: Error | undefined;

  const bump = (value: unknown): void => {
    if (typeof value !== "number" || !Number.isFinite(value)) return;
    if (value <= basisT) return;
    basisT = value;
    // copy: a subscriber may unsubscribe itself while being notified
    for (const cb of [...listeners]) cb(basisT);
  };

  /** The socket is gone: nothing in flight can ever be answered. */
  const die = (message: string): void => {
    if (dead !== undefined) return;
    dead = new Error(message);
    queued.length = 0;
    const waiting = [...pending.values()];
    pending.clear();
    for (const p of waiting) p.reject(dead);
  };

  socket.addEventListener("open", () => {
    open = true;
    for (const frame of queued.splice(0)) socket.send(frame);
  });
  socket.addEventListener("close", () => die("ripple: session socket closed"));
  socket.addEventListener("error", () => die("ripple: session socket failed"));
  socket.addEventListener("message", (ev: { data?: unknown }) => {
    const data = typeof ev?.data === "string" ? ev.data : undefined;
    if (data === undefined) return;
    let frame: Record<string, unknown>;
    try {
      frame = record(JSON.parse(data));
    } catch {
      return;
    }
    if (typeof frame.id === "number") {
      const p = pending.get(frame.id);
      if (p === undefined) return;
      pending.delete(frame.id);
      bump(record(frame.body).t);
      p.resolve(responseOf(frame));
      return;
    }
    if (frame.op === "t") bump(frame.t);
  });

  const fetch: FetchLike = (url, init) => {
    const frame = frameOf(options.name, url, init);
    if (frame === undefined) return fallback(url, init);
    if (dead !== undefined) return Promise.reject(dead);
    const id = nextId++;
    return new Promise<Response>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      const text = JSON.stringify({ id, ...frame });
      if (!open) {
        queued.push(text);
        return;
      }
      try {
        socket.send(text);
      } catch (cause) {
        pending.delete(id);
        reject(cause);
      }
    });
  };

  return {
    fetch,
    get t() {
      return basisT;
    },
    onT: (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    close: () => {
      const already = dead !== undefined;
      die("ripple: session closed");
      if (!already) {
        try {
          socket.close();
        } catch {
          // closing a socket that never opened is not an error worth raising
        }
      }
    },
  };
};
