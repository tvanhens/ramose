/**
 * One durable overlay follower per origin per db.
 *
 * The worker (or the in-page fallback) owns: overlay, session socket,
 * persist, outbox. Tabs attach a {@link MessagePort} and speak
 * {@link ./port.ts}. On notify the follower re-runs standing query
 * subscriptions and posts structured-cloneable rows — tabs never hold
 * {@link Connection} or raw datoms.
 */

import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type { AnyCatalog } from "./Catalog.ts";
import type { DbError } from "./Errors.ts";
import { type FetchLike, globalFetch, send } from "./http.ts";
import {
  type Overlay,
  type OverlayAck,
  openOverlay,
} from "./overlay.ts";
import type { ByteStore } from "./persist.ts";
import { memoryStore, opfsStore } from "./persist.ts";
import {
  type PortEvent,
  type PortLike,
  type PortRequest,
  asPortRequest,
  classifyPort,
  encodeError,
} from "./port.ts";
import {
  type Session,
  globalWebSocket,
  openSession,
  type SocketFactory,
} from "./session.ts";

export interface StandingSub {
  readonly subId: string;
  readonly kind: "q" | "pull";
  readonly body: Record<string, unknown>;
  readonly port: PortLike;
}

export interface Follower {
  readonly overlay: Overlay;
  readonly name: string;
  attach(port: PortLike): () => void;
  ready(retry?: boolean): Promise<void>;
  close(): void;
}

export interface FollowerOptions {
  readonly name: string;
  readonly session: Session;
  readonly post: (
    tx: readonly unknown[],
    clientTxId: string,
  ) => Effect.Effect<unknown, DbError>;
  readonly catalog?: AnyCatalog | undefined;
  readonly schema?: readonly unknown[] | undefined;
  readonly store?: ByteStore | undefined;
}

export const openFollower = (options: FollowerOptions): Follower => {
  const overlay = openOverlay({
    session: options.session,
    post: options.post,
    catalog: options.catalog,
    schema: options.schema,
    store: options.store,
    name: options.name,
  });

  const ports = new Set<PortLike>();
  const subs = new Map<string, StandingSub>();
  let closed = false;

  const postEvent = (port: PortLike, event: PortEvent): void => {
    try {
      port.postMessage(event);
    } catch {
      // port gone — detach on the next turn
    }
  };

  const fanoutChange = (): void => {
    const epoch = overlay.epoch;
    for (const port of ports) postEvent(port, { op: "change", epoch });
    for (const sub of subs.values()) {
      void Effect.runPromise(overlay.read(sub.kind, sub.body)).then(
        (body) => {
          postEvent(sub.port, {
            op: "rows",
            subId: sub.subId,
            rows: body,
            epoch: overlay.epoch,
          });
        },
        () => {
          // a standing read that fails stays standing; next notify retries
        },
      );
    }
  };

  // Real notify — do not stub. Overlay apply notifies; persist is behind it.
  overlay.onChange(fanoutChange);

  const reply = (
    port: PortLike,
    id: number,
    result: { ok: true; body: unknown } | { ok: false; error: DbError },
  ): void => {
    if (result.ok) {
      postEvent(port, { id, op: "reply", ok: true, body: result.body });
    } else {
      postEvent(port, {
        id,
        op: "reply",
        ok: false,
        error: encodeError(result.error),
      });
    }
  };

  const handle = async (port: PortLike, req: PortRequest): Promise<void> => {
    try {
      switch (req.op) {
        case "open":
        case "auth":
          reply(port, req.id, { ok: true, body: { ok: true } });
          return;
        case "ready":
          await Effect.runPromise(overlay.ready());
          reply(port, req.id, {
            ok: true,
            body: { confirmedT: overlay.confirmedT, epoch: overlay.epoch },
          });
          return;
        case "transact": {
          const ack = await Effect.runPromise(overlay.transact(req.tx));
          reply(port, req.id, { ok: true, body: ack });
          return;
        }
        case "q":
        case "pull": {
          const body = await Effect.runPromise(overlay.read(req.op, req.body));
          reply(port, req.id, { ok: true, body });
          return;
        }
        case "subscribe": {
          subs.set(req.subId, {
            subId: req.subId,
            kind: req.kind,
            body: req.body,
            port,
          });
          const body = await Effect.runPromise(overlay.read(req.kind, req.body));
          postEvent(port, {
            op: "rows",
            subId: req.subId,
            rows: body,
            epoch: overlay.epoch,
          });
          reply(port, req.id, { ok: true, body: { subId: req.subId } });
          return;
        }
        case "unsubscribe":
          subs.delete(req.subId);
          reply(port, req.id, { ok: true, body: { ok: true } });
          return;
        case "flush":
          await overlay.flush();
          reply(port, req.id, { ok: true, body: { ok: true } });
          return;
        case "close":
          detach(port);
          reply(port, req.id, { ok: true, body: { ok: true } });
          return;
      }
    } catch (err) {
      reply(port, req.id, { ok: false, error: classifyPort(err) });
    }
  };

  const onMessage = (port: PortLike) => (ev: MessageEvent) => {
    const req = asPortRequest(ev.data);
    if (req === undefined) return;
    void handle(port, req);
  };

  const listeners = new WeakMap<PortLike, (ev: MessageEvent) => void>();

  const detach = (port: PortLike): void => {
    ports.delete(port);
    for (const [id, sub] of [...subs]) {
      if (sub.port === port) subs.delete(id);
    }
    const cb = listeners.get(port);
    if (cb !== undefined) port.removeEventListener?.("message", cb);
  };

  const attach = (port: PortLike): (() => void) => {
    if (closed) return () => {};
    ports.add(port);
    const cb = onMessage(port);
    listeners.set(port, cb);
    port.addEventListener("message", cb);
    port.start?.();
    return () => detach(port);
  };

  return {
    overlay,
    name: options.name,
    attach,
    ready: async (retry = true) => {
      await Effect.runPromise(overlay.ready(retry));
    },
    close: () => {
      if (closed) return;
      closed = true;
      for (const port of [...ports]) detach(port);
      subs.clear();
    },
  };
};

export interface HostOpen {
  readonly name: string;
  readonly url: string;
  readonly schema?: readonly unknown[] | undefined;
  readonly token?: string | undefined;
  readonly store?: ByteStore | undefined;
  readonly fetch?: FetchLike | undefined;
  readonly connect?: SocketFactory | undefined;
}

/**
 * One SharedWorker (or in-page host) multiplexes followers by db name.
 * Last port detach does not wipe OPFS — the next tab hydrates.
 */
export const openFollowerHost = (defaults?: {
  readonly store?: ByteStore | undefined;
  readonly fetch?: FetchLike | undefined;
  readonly connect?: SocketFactory | undefined;
}): {
  attach(port: PortLike): void;
  follower(name: string): Follower | undefined;
  close(): void;
} => {
  const followers = new Map<string, Follower>();
  const sessions = new Map<string, Session>();
  let closed = false;
  let tokenOf: string | undefined;
  let unlockToken: ((value: string | undefined) => void) | undefined;
  let tokenReady: Promise<string | undefined> | undefined;

  const noteToken = (value: string | undefined): void => {
    if (typeof value === "string") tokenOf = value;
    unlockToken?.(tokenOf);
    unlockToken = undefined;
    tokenReady = Promise.resolve(tokenOf);
  };

  const waitToken = (): Promise<string | undefined> => {
    if (tokenOf !== undefined) return Promise.resolve(tokenOf);
    tokenReady ??= new Promise((resolve) => {
      unlockToken = resolve;
    });
    return tokenReady;
  };

  const followerOf = (open: HostOpen): Follower => {
    const existing = followers.get(open.name);
    if (existing !== undefined) return existing;
    const fetch = open.fetch ?? defaults?.fetch ?? globalFetch;
    const connect =
      open.connect ?? defaults?.connect ?? globalWebSocket() ?? ((url: string) => {
        throw new Error(`ramose: no WebSocket to follow ${open.name}`);
      });
    // Token is for the socket and writes. Hydrate / first paint must
    // not wait on it — `waitToken` parks `session.request` and `post`.
    const token = (): Promise<Redacted.Redacted<string> | undefined> => {
      const immediate = open.token ?? tokenOf;
      if (immediate !== undefined && immediate.length > 0) {
        return Promise.resolve(Redacted.make(immediate));
      }
      return waitToken().then((value) =>
        value === undefined || value.length === 0
          ? undefined
          : Redacted.make(value),
      );
    };
    const session = openSession({
      url: () => Promise.resolve(open.url.replace(/\/+$/, "")),
      name: open.name,
      token,
      connect,
    });
    sessions.set(open.name, session);
    const post = (
      tx: readonly unknown[],
      clientTxId: string,
    ): Effect.Effect<unknown, DbError> =>
      Effect.gen(function* () {
        const tok = yield* Effect.promise(() =>
          token().then((t) => (t === undefined ? undefined : Redacted.value(t))),
        );
        const result = yield* send({
          fetch,
          url: open.url.replace(/\/+$/, ""),
          method: "POST",
          path: `/db/${encodeURIComponent(open.name)}/transact`,
          token: tok,
          body: { tx, clientTxId },
        });
        return result.body;
      });
    const created = openFollower({
      name: open.name,
      session,
      post,
      schema: open.schema,
      store: open.store ?? defaults?.store,
    });
    followers.set(open.name, created);
    return created;
  };

  const attach = (port: PortLike): void => {
    if (closed) return;
    port.start?.();
    const onMsg = (ev: MessageEvent) => {
      const req = asPortRequest(ev.data);
      if (req === undefined) return;
      if (req.op === "open") {
        if (typeof req.token === "string") noteToken(req.token);
        const f = followerOf(req);
        const child = ev.ports?.[0] as PortLike | undefined;
        f.attach(child ?? port);
        try {
          (child ?? port).postMessage({
            id: req.id,
            op: "reply",
            ok: true,
            body: { ok: true },
          } satisfies PortEvent);
        } catch {
          /* port gone */
        }
        return;
      }
      if (req.op === "auth") {
        noteToken(req.token);
        try {
          port.postMessage({
            id: req.id,
            op: "reply",
            ok: true,
            body: { ok: true },
          } satisfies PortEvent);
        } catch {
          /* port gone */
        }
      }
    };
    port.addEventListener("message", onMsg);
  };

  return {
    attach,
    follower: (name) => followers.get(name),
    close: () => {
      if (closed) return;
      closed = true;
      noteToken(tokenOf);
      for (const f of followers.values()) f.close();
      for (const s of sessions.values()) s.close();
      followers.clear();
      sessions.clear();
    },
  };
};

/** SharedWorker / in-page default persist: OPFS, else a fresh memory page. */
export const defaultStore = async (): Promise<ByteStore> =>
  (await opfsStore()) ?? memoryStore();

/**
 * Worker script beside this module. The specifier is a string literal
 * Vite/webpack rewrite — a computed extension is invisible to the
 * bundler, the constructor succeeds on a 404, and every tab falls
 * through to its own in-page overlay. `tsc` emits `.js` next to
 * `follower.js` / `Databases.js`; from source Vite resolves the `.js`
 * specifier to `follower-worker.ts`.
 */
export const followerWorkerUrl = (): URL =>
  new URL("./follower-worker.js", import.meta.url);

export type { OverlayAck };
