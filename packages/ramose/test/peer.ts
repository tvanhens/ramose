/**
 * One fake peer for the whole client suite: an HTTPS `fetch` and a
 * `WebSocket` that speak the shapes `packages/ramose/src/worker` actually speaks.
 *
 * The split matters, because it is the design: **writes are HTTPS**
 * (`POST /db/:name/transact`) and **reads and `t` ticks are the socket**
 * (`GET /db/:name/session`). A test that records both can therefore prove
 * which wire a call took, which is most of what these tests are for.
 */

import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Redacted from "effect/Redacted";
import { TestClock } from "effect/testing";
import {
  type EffectClientOptions,
  Databases,
  type DatabasesShape,
  layer,
  makeDatabases,
} from "../src/db/internal.ts";

export interface Frame {
  id: number;
  op: string;
  [field: string]: unknown;
}

export interface Reply {
  /** Absent is a 200; an `auth` ack is `{ ok: true }`. */
  status?: number;
  ok?: boolean;
  body?: unknown;
  headers?: Record<string, string>;
  /** An `auth` ack may name the swapped principal. */
  principal?: { eid: number | null; class: string };
  /** Answer after this many ms instead of on the next microtask. */
  delay?: number;
}

export interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
}

/** What a fake socket does when a frame arrives. `undefined` = never answered. */
export type Answer = (frame: Frame) => Reply | undefined;

export interface FakeSocket {
  /** Every frame this socket received. */
  readonly sent: Frame[];
  /** The handshake url, token query param included. */
  readonly url: string;
  /** `true` once the client closed it (or it dropped). */
  readonly closed: boolean;
  /** Push an unsolicited server frame (`{ op: "tx", t, datoms }`). */
  push(frame: unknown): void;
  /** The isolate died. */
  drop(): void;
}

export interface FakePeer {
  readonly fetch: typeof fetch;
  readonly webSocket: typeof WebSocket;
  /** Every socket this peer has handed out, oldest first. */
  readonly sockets: FakeSocket[];
  /** The newest socket, which is the live one. */
  readonly socket: FakeSocket;
  /** Every frame across every socket. */
  readonly frames: Frame[];
  /** Every HTTPS request. */
  readonly calls: Call[];
  frameOps(op: string): Frame[];
  push(frame: unknown): void;
  drop(): void;
}

export interface PeerOptions {
  /** Answers socket frames. */
  readonly answer?: Answer | undefined;
  /** Answers HTTPS requests. A Promise delays the response (outbox / overlay tests). */
  readonly http?:
    | ((call: Call) =>
        | {
            status?: number;
            body: unknown;
            headers?: Record<string, string>;
          }
        | Promise<{
            status?: number;
            body: unknown;
            headers?: Record<string, string>;
          }>)
    | undefined;
  /** Refuse the next `n` upgrades by closing the socket at once. */
  readonly refuseUpgrades?: number | undefined;
}

const DEFAULT_ACK = { t: 2, txEid: 13194139533319, tempids: {}, datoms: [] as const };

export type Http = NonNullable<PeerOptions["http"]>;

/** The worker's `GET /db/:name/info` shape, at the transact ack's basis. */
const defaultHttp: Http = (call) => {
  const info = /^\/db\/([^/]+)\/info$/.exec(new URL(call.url).pathname);
  if (info !== null && call.method === "GET") {
    return {
      body: {
        db: decodeURIComponent(info[1]!),
        t: DEFAULT_ACK.t,
        principal: { eid: null, class: "admin" },
      },
    };
  }
  return { body: DEFAULT_ACK };
};

export const fakePeer = (options: PeerOptions = {}): FakePeer => {
  const answer: Answer = options.answer ?? (() => ({ body: {} }));
  const http: Http = options.http ?? defaultHttp;
  const sockets: FakeSocket[] = [];
  const frames: Frame[] = [];
  const calls: Call[] = [];
  let refusals = options.refuseUpgrades ?? 0;

  class Socket {
    readonly sent: Frame[] = [];
    readonly url: string;
    private readonly listeners = new Map<string, ((ev: any) => void)[]>();
    private dead = false;

    constructor(url: string) {
      this.url = url;
      const refuse = refusals > 0;
      if (refuse) refusals -= 1;
      // a real socket is CONNECTING until its open event. A refused
      // upgrade (browser) fires error then close, never open.
      queueMicrotask(() => {
        if (refuse) {
          this.emit("error", {});
          this.emit("close", {});
        } else this.emit("open", {});
      });
    }

    readonly readyState = 0;

    get closed(): boolean {
      return this.dead;
    }

    emit(type: string, ev: unknown): void {
      for (const cb of this.listeners.get(type) ?? []) cb(ev);
    }

    addEventListener(type: string, cb: (ev: any) => void): void {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb]);
    }

    send(data: string): void {
      if (this.dead) throw new Error("socket is closed");
      const frame = JSON.parse(data) as Frame;
      this.sent.push(frame);
      frames.push(frame);
      const reply =
        frame.op === "sync"
          ? (answer(frame) ?? { body: { t: 0, from: frame.from ?? 0 } })
          : answer(frame);
      if (reply === undefined) return;
      const { delay, ...rest } = reply;
      const deliver = () => {
        if (this.dead) return;
        // #112: a sync dump is an unsolicited resync, then the correlated ack
        const body = rest.body as { t?: unknown; datoms?: unknown } | undefined;
        if (frame.op === "sync" && Array.isArray(body?.datoms)) {
          this.emit("message", {
            data: JSON.stringify({
              op: "resync",
              t: body.t,
              datoms: body.datoms,
            }),
          });
        }
        this.emit("message", {
          data: JSON.stringify({ id: frame.id, ...rest }),
        });
      };
      if (delay === undefined) queueMicrotask(deliver);
      else setTimeout(deliver, delay);
    }

    close(): void {
      if (this.dead) return;
      this.dead = true;
      this.emit("close", {});
    }

    push(frame: unknown): void {
      this.emit("message", { data: JSON.stringify(frame) });
    }

    drop(): void {
      this.dead = true;
      this.emit("close", {});
    }
  }

  // a real `WebSocket` is called with `new`, so this has to be constructible
  function WebSocketImpl(this: unknown, url: string) {
    const socket = new Socket(url);
    sockets.push(socket as unknown as FakeSocket);
    return socket;
  }
  const webSocket = WebSocketImpl as unknown as typeof WebSocket;

  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(url),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body:
        typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const reply = await http(call);
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json", ...(reply.headers ?? {}) },
    });
  }) as unknown as typeof fetch;

  return {
    fetch: fetchImpl,
    webSocket,
    sockets,
    get socket() {
      return sockets[sockets.length - 1]!;
    },
    frames,
    calls,
    frameOps: (op) => frames.filter((f) => f.op === op),
    push: (frame) => sockets[sockets.length - 1]?.push(frame),
    drop: () => sockets[sockets.length - 1]?.drop(),
  };
};

export interface Client {
  readonly ramose: DatabasesShape;
  readonly runtime: ManagedRuntime.ManagedRuntime<Databases, never>;
  dispose(): Promise<void>;
}

/** A client over a fake peer, disposed by the caller. */
export const client = (
  peer: Pick<FakePeer, "fetch" | "webSocket">,
  options: Partial<EffectClientOptions> = {},
): Client => {
  const runtime = ManagedRuntime.make(
    layer({
      url: options.url ?? "https://peer.example.com",
      token: options.token,
      fetch: options.fetch ?? peer.fetch,
      webSocket: options.webSocket ?? peer.webSocket,
    }),
  );
  return {
    ramose: runtime.runSync(Databases),
    runtime,
    dispose: () => runtime.dispose(),
  };
};

/**
 * The same client with no socket at all — what a Worker reaching the peer over
 * a service binding gets. Reads fall back to `POST /db/:name/query|pull`, and
 * `db.live` is unavailable. This is the internal factory the next slice calls.
 */
export const httpsClient = (
  peer: Pick<FakePeer, "fetch">,
  options: { token?: Effect.Effect<Redacted.Redacted<string>> } = {},
) =>
  makeDatabases({
    url: Effect.succeed("https://peer.example.com"),
    token: options.token,
    fetch: (url, init) =>
      peer.fetch(url, init as RequestInit) as unknown as Promise<Response>,
  });

export const redacted = (value: string) => Redacted.make(value);

/** Run an Effect while advancing its retry sleeps without waiting in real time. */
export const runWithTestClock = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(effect);
      // Promise-backed fetch / socket attempts finish outside Effect's
      // scheduler. Give each one an event-loop turn before advancing the next
      // retry sleep; six turns cover the transport's six-attempt ladder.
      for (let n = 0; n < 6; n++) {
        yield* Effect.promise(() => Bun.sleep(0));
        yield* TestClock.adjust("1 minute");
      }
      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestClock.layer())),
  );

/** Every pass is a handful of microtasks; a tick is plenty. */
export const settle = (ms = 20) => Bun.sleep(ms);

/**
 * Poll until `cond` is true, or throw after `timeoutMs`.
 *
 * Use this for live-session assertions that used to `await settle()` and
 * then check a frame / row-count: under suite contention the frame can
 * land after a fixed sleep. Negative assertions (nothing more arrived)
 * still want a short `settle()`.
 */
export const until = async (
  cond: () => boolean,
  timeoutMs = 2_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() >= deadline) {
      throw new Error(`until: timed out after ${timeoutMs}ms`);
    }
    await Bun.sleep(5);
  }
};
