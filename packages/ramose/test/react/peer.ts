/**
 * `scriptedPeer` for React hook tests — exact frame control, not a
 * stand-in for the deployed peer. Public Worker/live behavior runs
 * against `test/local`.
 *
 * A `WebSocket` factory that records every socket and frame, plus a
 * recording `fetch`. `answer` decides each frame's reply; `push`
 * delivers `{ op: "tx", t, datoms }`; `http` answers HTTPS.
 *
 * The client-suite double lives in `packages/ramose/test/peer.ts`.
 */

/** A frame the client sent — `q`, `pull`, `auth`. */
export interface Frame {
  readonly id: number;
  readonly op: string;
  readonly [field: string]: unknown;
}

/** How a frame is answered. `status` absent is a 200. */
export interface Reply {
  readonly status?: number;
  readonly body?: unknown;
  /** Answer after this many ms instead of on the next microtask. */
  readonly delay?: number;
}

/** An HTTPS request, recorded. */
export interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

/** Decides each frame's reply; `undefined` holds the frame unanswered. */
export type Answer = (frame: Frame) => Reply | undefined;

export interface FakeSocket {
  /** The handshake url — which peer, which database. */
  readonly url: string;
  /** `true` once the client closed it. */
  readonly closed: boolean;
  /** Every frame this socket received, oldest first. */
  readonly sent: Frame[];
  /** Deliver a server frame (`{ op: "tx", t, datoms }`, or a held frame's reply). */
  push(frame: unknown): void;
  drop(): void;
}

export interface ScriptedPeer {
  readonly fetch: typeof fetch;
  readonly webSocket: typeof WebSocket;
  /** Every socket handed out, oldest first. */
  readonly sockets: FakeSocket[];
  /** Every HTTPS request, oldest first. */
  readonly calls: Call[];
  /** Every frame across every socket, oldest first. */
  readonly frames: Frame[];
  frameOps(op: string): Frame[];
  /** Deliver a server frame on the newest socket. */
  push(frame: unknown): void;
  /** Close the newest socket as if the isolate died. */
  drop(): void;
}

export interface PeerOptions {
  /** Answers socket frames. Defaults to `{ t: 1, root: 1, result: [] }`. */
  readonly answer?: Answer | undefined;
  /** Answers HTTPS; the default acks transact and answers `/info` at `t: 1`. */
  readonly http?:
    | ((call: Call) => Reply | Promise<Reply> | undefined)
    | undefined;
}

const defaultHttp = (call: Call): Reply => {
  const info = /^\/db\/([^/]+)\/info$/.exec(new URL(call.url).pathname);
  if (info !== null && call.method === "GET") {
    return { body: { db: decodeURIComponent(info[1]!), t: 1 } };
  }
  return { body: { t: 1, txEid: 1, tempids: {}, datoms: 0 } };
};

export const scriptedPeer = (options: PeerOptions = {}): ScriptedPeer => {
  const answer: Answer =
    options.answer ?? (() => ({ body: { t: 1, root: 1, result: [] } }));
  const sockets: FakeSocket[] = [];
  const calls: Call[] = [];
  const frames: Frame[] = [];

  class Socket {
    readonly url: string;
    readonly sent: Frame[] = [];
    private readonly listeners = new Map<string, ((ev: unknown) => void)[]>();
    private dead = false;

    constructor(url: string) {
      this.url = url;
      // a real socket is CONNECTING until its open event
      queueMicrotask(() => {
        if (!this.dead) this.emit("open", {});
      });
    }

    readonly readyState = 0;

    get closed(): boolean {
      return this.dead;
    }

    private emit(type: string, ev: unknown): void {
      for (const cb of this.listeners.get(type) ?? []) cb(ev);
    }

    addEventListener(type: string, cb: (ev: unknown) => void): void {
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

  function WebSocketImpl(this: unknown, url: string) {
    const socket = new Socket(url);
    sockets.push(socket);
    return socket;
  }

  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(url),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const raw = options.http?.(call);
    const reply = (raw === undefined ? defaultHttp(call) : await raw) ??
      defaultHttp(call);
    if (reply.delay !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, reply.delay));
    }
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  return {
    fetch: fetchImpl,
    webSocket: WebSocketImpl as unknown as typeof WebSocket,
    sockets,
    calls,
    frames,
    frameOps: (op) => frames.filter((f) => f.op === op),
    push: (frame) => sockets[sockets.length - 1]?.push(frame),
    drop: () => sockets[sockets.length - 1]?.drop(),
  };
};
