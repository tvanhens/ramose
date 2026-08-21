/**
 * Durable overlay follower — persist is the apply path, pending is the
 * outbox, tabs speak a port protocol. Honest: new overlay objects, byte
 * stores (not the same Connection), real notify, pinned resync dumps.
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";
import { Connection } from "../src/internal/core/conn.ts";
import {
  Index,
  ValueTag,
  toWireDatom,
  type WireDatom,
} from "../src/internal/core/index.ts";
import { makeDatabases } from "../src/db/Databases.ts";
import { schemaTx } from "../src/db/ensure.ts";
import { NetworkError, TxRejected } from "../src/db/Errors.ts";
import {
  followerWorkerUrl,
  followerWorkerUrlBeside,
  openFollower,
} from "../src/db/follower.ts";
import { fromStandardFetch } from "../src/db/http.ts";
import { query } from "../src/db/NavQuery.ts";
import { openOverlay, type Overlay } from "../src/db/overlay.ts";
import {
  type ByteStore,
  encodeSnap,
  memoryStore,
  type OverlaySnap,
} from "../src/db/persist.ts";
import type { PortEvent } from "../src/db/port.ts";
import type { Session } from "../src/db/session.ts";
import { Movies, User } from "./db/fixture.ts";
import { fakePeer } from "./peer.ts";

const run = <A, E>(eff: Effect.Effect<A, E>) => Effect.runPromise(eff);

const namesQ = {
  find: ["?n"],
  where: [["?e", ":user/name", "?n"]],
};

const dirStore = (root: string): ByteStore => ({
  get: async (key) => {
    try {
      const buf = await readFile(join(root, key.replace(/[^a-zA-Z0-9._-]/g, "_")));
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch {
      return undefined;
    }
  },
  put: async (key, value) => {
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, key.replace(/[^a-zA-Z0-9._-]/g, "_")),
      value,
    );
  },
});

const until = async (pred: () => boolean, ms = 2_000): Promise<void> => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("until timed out");
    await Bun.sleep(5);
  }
};

const fakeSession = (opts?: {
  readonly onSync?: (from: number) =>
    | {
        readonly body: unknown;
        readonly push?: Record<string, unknown>;
      }
    | Promise<{
        readonly body: unknown;
        readonly push?: Record<string, unknown>;
      }>;
}): Session & {
  readonly syncs: number[];
  closed: boolean;
  pusher: (f: Record<string, unknown>) => void;
} => {
  const syncs: number[] = [];
  let basis = 0;
  let epoch = 0;
  let pusher: (f: Record<string, unknown>) => void = () => {};
  return {
    syncs,
    get pusher() {
      return pusher;
    },
    set pusher(cb) {
      pusher = cb;
    },
    get t() {
      return basis;
    },
    generation: 1,
    principal: undefined,
    connects: 1,
    closed: false,
    get epoch() {
      return epoch;
    },
    request: async (frame) => {
      if (frame.op === "sync") {
        const from = typeof frame.from === "number" ? frame.from : 0;
        syncs.push(from);
        const got = (await opts?.onSync?.(from)) ?? { body: { t: from, from } };
        if (got.push !== undefined) pusher(got.push);
        return { status: 200, body: got.body };
      }
      return { status: 200, body: {} };
    },
    bump: (n) => {
      if (n > basis) basis = n;
    },
    nudge: () => {
      epoch += 1;
    },
    onWake: () => () => {},
    onPush: (cb) => {
      pusher = cb;
      return () => {};
    },
    close: () => {},
  };
};

const schemaConn = async () => {
  const conn = await Connection.create();
  await conn.transact(schemaTx(Movies) as unknown[]);
  return conn;
};

const snapshotDatoms = async (conn: Connection): Promise<WireDatom[]> => {
  const datoms: WireDatom[] = [];
  for await (const chunk of conn.db().datoms(Index.EAVT, {})) {
    for (const d of chunk) datoms.push(toWireDatom(d));
  }
  return datoms;
};

const namesOf = async (overlay: Overlay): Promise<string[]> => {
  const body = (await run(
    overlay.read("q", { query: namesQ }),
  )) as { result: unknown };
  const rows = body.result as unknown[][];
  return rows.map((r) => String(r[0])).sort();
};

describe("hydrate then sync is a walk", () => {
  test("first q / live emit Ada while sync is still in flight; from >= rootT is a walk", async () => {
    const store = memoryStore();
    const world = await schemaConn();
    await world.transact([{ ":user/name": "Ada" }]);
    const dump = await snapshotDatoms(world);
    const rootT = world.t;

    const first = fakeSession();
    const a = openOverlay({
      session: first,
      post: () => Effect.succeed({}),
      catalog: Movies,
      store,
      name: "movies",
    });
    await run(a.ready());
    await a.handlePush({ op: "resync", t: rootT, datoms: dump });
    expect(await namesOf(a)).toEqual(["Ada"]);
    const snap = await a.snapshot();
    expect(snap.confirmedT).toBe(rootT);
    expect(snap.confirmed.length).toBeGreaterThan(0);

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const walks: number[] = [];
    const second = fakeSession({
      onSync: async (from) => {
        walks.push(from);
        await held;
        return { body: { t: rootT, from } };
      },
    });
    const b = openOverlay({
      session: second,
      post: () => Effect.succeed({}),
      catalog: Movies,
      store,
      name: "movies",
    });
    expect(b).not.toBe(a);

    const live: string[][] = [];
    b.onChange(() => {
      void namesOf(b).then((n) => live.push(n));
    });

    await run(b.ready());
    expect(b.epoch).toBeGreaterThan(0);
    expect(await namesOf(b)).toEqual(["Ada"]);
    await until(() => live.some((n) => n[0] === "Ada"));
    expect(live.at(-1)).toEqual(["Ada"]);
    await until(() => walks.length === 1);
    expect(walks).toEqual([rootT]);
    expect(second.syncs).toEqual([rootT]);
    expect(b.confirmedT).toBe(rootT);

    release();
    await until(() => second.syncs.length === 1 && walks.length === 1);
    expect(await namesOf(b)).toEqual(["Ada"]);
    const snapB = await b.snapshot();
    expect(snapB.confirmed).not.toBe(snap.confirmed);
    expect(snapB.confirmedT).toBe(rootT);
  });

  test("closed client fails ready — no session yet is not closed", async () => {
    const store = memoryStore();
    const world = await schemaConn();
    await world.transact([{ ":user/name": "Ada" }]);
    const dump = await snapshotDatoms(world);
    const live = openOverlay({
      session: fakeSession(),
      post: () => Effect.succeed({}),
      catalog: Movies,
      store,
      name: "movies",
    });
    await run(live.ready());
    await live.handlePush({ op: "resync", t: world.t, datoms: dump });

    const closed = fakeSession();
    closed.closed = true;
    const overlay = openOverlay({
      session: closed,
      post: () => Effect.succeed({}),
      catalog: Movies,
      store,
      name: "movies",
    });
    await expect(run(overlay.ready())).rejects.toMatchObject({
      _tag: "NetworkError",
    });

    const connecting = fakeSession({
      onSync: async () => {
        await new Promise(() => {});
        return { body: { t: world.t } };
      },
    });
    const open = openOverlay({
      session: connecting,
      post: () => Effect.succeed({}),
      catalog: Movies,
      store,
      name: "movies",
    });
    await run(open.ready());
    expect(await namesOf(open)).toEqual(["Ada"]);
    expect(connecting.closed).toBe(false);
  });
});

describe("reload restores confirmed and pending", () => {
  test("new overlay, same byte store — no network dump", async () => {
    const root = await mkdtemp(join(tmpdir(), "ramose-overlay-"));
    const store = dirStore(root);
    const world = await schemaConn();
    await world.transact([{ ":user/name": "Ada" }]);
    const dump = await snapshotDatoms(world);

    let posts = 0;
    const session = fakeSession({
      onSync: (from) => ({ body: { t: from, from } }),
    });
    const live: Overlay = openOverlay({
      session,
      post: () => {
        posts += 1;
        return Effect.fail(
          new NetworkError({ message: "offline" }),
        );
      },
      catalog: Movies,
      store,
      name: "movies",
    });
    await run(live.ready());
    await live.handlePush({ op: "resync", t: world.t, datoms: dump });
    await run(live.transact([{ ":user/name": "Bea" }]));
    expect(await namesOf(live)).toEqual(["Ada", "Bea"]);
    expect(posts).toBe(1);
    const before = await live.snapshot();
    expect(before.pending).toHaveLength(1);

    const bytes = await store.get("overlay.movies");
    expect(bytes).toBeDefined();
    const decoded = JSON.parse(new TextDecoder().decode(bytes));
    expect(decoded.pending).toHaveLength(1);

    const reloaded = openOverlay({
      session: fakeSession({
        onSync: (from) => ({ body: { t: from, from } }),
      }),
      post: () => Effect.fail(new NetworkError({ message: "still offline" })),
      catalog: Movies,
      store,
      name: "movies",
    });
    expect(reloaded).not.toBe(live);
    await run(reloaded.ready());
    expect(reloaded.confirmedT).toBe(world.t);
    expect(await namesOf(reloaded)).toEqual(["Ada", "Bea"]);
    const after = await reloaded.snapshot();
    expect(after.pending).toHaveLength(1);
    expect(after.pending[0]!.clientTxId).toBe(before.pending[0]!.clientTxId);
    expect(after.confirmed).not.toBe(before.confirmed);
  });

  test("hydrated ready survives a dead sync — no network dump", async () => {
    const store = memoryStore();
    const world = await schemaConn();
    await world.transact([{ ":user/name": "Ada" }]);
    const dump = await snapshotDatoms(world);
    const live = openOverlay({
      session: fakeSession(),
      post: () => Effect.fail(new NetworkError({ message: "offline" })),
      catalog: Movies,
      store,
      name: "movies",
    });
    await run(live.ready());
    await live.handlePush({ op: "resync", t: world.t, datoms: dump });
    await run(live.transact([{ ":user/name": "Bea" }]));

    const dead = fakeSession({
      onSync: () => {
        throw new NetworkError({ message: "offline" });
      },
    });
    const reloaded = openOverlay({
      session: dead,
      post: () => Effect.fail(new NetworkError({ message: "offline" })),
      catalog: Movies,
      store,
      name: "movies",
    });
    await run(reloaded.ready());
    expect(reloaded.confirmedT).toBe(world.t);
    expect(await namesOf(reloaded)).toEqual(["Ada", "Bea"]);
    await until(() => dead.syncs.length === 1);
    expect(dead.syncs).toEqual([world.t]);
  });
});

describe("offline transact / outbox", () => {
  test("visible on live; flush POST later; 409 drops only that layer", async () => {
    const world = await schemaConn();
    await world.transact([{ ":user/name": "Ada" }]);
    const dump = await snapshotDatoms(world);

    const session = fakeSession({
      onSync: (from) => ({ body: { t: from, from } }),
    });
    const posted: string[] = [];
    let mode: "offline" | "flush" = "offline";
    let rejectOnce = true;
    const nameA = world.db().schema.requireAttr(":user/name").id;
    const overlay = openOverlay({
      session,
      post: (tx, id) => {
        posted.push(id);
        if (mode === "offline") {
          return Effect.fail(new NetworkError({ message: "offline" }));
        }
        if (rejectOnce) {
          rejectOnce = false;
          return Effect.fail(
            new TxRejected({ message: "stopped", code: "tx/unique-conflict" }),
          );
        }
        return Effect.succeed({
          t: world.t + 2,
          txEid: 1,
          tempids: {},
          datoms: [
            toWireDatom({
              e: 4001,
              a: nameA,
              vt: ValueTag.Str,
              v: "Cal",
              t: world.t + 2,
              op: true,
            }),
          ],
          clientTxId: id,
        });
      },
      catalog: Movies,
      store: memoryStore(),
      name: "movies",
    });
    await run(overlay.ready());
    await overlay.handlePush({ op: "resync", t: world.t, datoms: dump });

    const ticks: number[] = [];
    overlay.onChange(() => {
      ticks.push(overlay.epoch);
    });

    await run(overlay.transact([{ ":user/name": "Bea" }]));
    await run(overlay.transact([{ ":user/name": "Cal" }]));
    expect(await namesOf(overlay)).toEqual(["Ada", "Bea", "Cal"]);
    expect(ticks.length).toBeGreaterThan(0);
    const pending = (await overlay.snapshot()).pending;
    expect(pending).toHaveLength(2);
    const [firstId, secondId] = pending.map((p) => p.clientTxId);

    mode = "flush";
    await overlay.flush();
    expect(await namesOf(overlay)).toEqual(["Ada", "Cal"]);
    const left = (await overlay.snapshot()).pending;
    expect(left.some((p) => p.clientTxId === firstId)).toBe(false);
    expect(left.map((p) => p.clientTxId)).toEqual([]);
    expect(secondId).toBeDefined();
  });
});

describe("two ports, one follower", () => {
  test("both live subs see one inbound {op:tx}; one transact is one pending world", async () => {
    const world = await schemaConn();
    await world.transact([{ ":user/name": "Ada" }]);
    const dump = await snapshotDatoms(world);
    const a = world.db().schema.requireAttr(":user/name").id;
    const inbound = toWireDatom({
      e: 3001,
      a,
      vt: ValueTag.Str,
      v: "Zoe",
      t: world.t + 1,
      op: true,
    });

    const session = fakeSession({
      onSync: (from) => ({ body: { t: from, from } }),
    });
    const follower = openFollower({
      name: "movies",
      session,
      post: () => Effect.fail(new NetworkError({ message: "offline" })),
      catalog: Movies,
      store: memoryStore(),
    });
    await follower.ready();
    await follower.overlay.handlePush({
      op: "resync",
      t: world.t,
      datoms: dump,
    });

    const c1 = new MessageChannel();
    const c2 = new MessageChannel();
    follower.attach(c1.port1);
    follower.attach(c2.port1);
    c1.port2.start();
    c2.port2.start();

    const rows1: unknown[] = [];
    const rows2: unknown[] = [];
    const collect = (port: MessagePort, into: unknown[]) => {
      port.addEventListener("message", (ev) => {
        const data = ev.data as PortEvent;
        if (data.op === "rows") into.push(data.rows);
      });
    };
    collect(c1.port2, rows1);
    collect(c2.port2, rows2);

    const rpc = (port: MessagePort, msg: object) =>
      new Promise<unknown>((resolve) => {
        const id = Math.floor(Math.random() * 1e9);
        const onMsg = (ev: MessageEvent) => {
          const data = ev.data as PortEvent;
          if (data.op === "reply" && data.id === id) {
            port.removeEventListener("message", onMsg);
            resolve(data);
          }
        };
        port.addEventListener("message", onMsg);
        port.postMessage({ id, ...msg });
      });

    await rpc(c1.port2, {
      op: "subscribe",
      subId: "s1",
      kind: "q",
      body: { query: namesQ },
    });
    await rpc(c2.port2, {
      op: "subscribe",
      subId: "s2",
      kind: "q",
      body: { query: namesQ },
    });
    await Bun.sleep(20);
    const before1 = rows1.length;
    const before2 = rows2.length;

    await follower.overlay.handlePush({
      op: "tx",
      t: world.t + 1,
      datoms: [inbound],
    });
    await Bun.sleep(20);
    expect(rows1.length).toBeGreaterThan(before1);
    expect(rows2.length).toBeGreaterThan(before2);
    const last1 = rows1.at(-1) as { result: unknown[][] };
    const last2 = rows2.at(-1) as { result: unknown[][] };
    expect(last1.result.map((r) => r[0]).sort()).toEqual(["Ada", "Zoe"]);
    expect(last2.result.map((r) => r[0]).sort()).toEqual(["Ada", "Zoe"]);

    const pendingBefore = (await follower.overlay.snapshot()).pending.length;
    await rpc(c1.port2, { op: "transact", tx: [{ ":user/name": "Bea" }] });
    await Bun.sleep(20);
    expect((await follower.overlay.snapshot()).pending.length).toBe(
      pendingBefore + 1,
    );
    const after1 = rows1.at(-1) as { result: unknown[][] };
    const after2 = rows2.at(-1) as { result: unknown[][] };
    expect(after1.result.map((r) => r[0]).sort()).toEqual(["Ada", "Bea", "Zoe"]);
    expect(after2.result.map((r) => r[0]).sort()).toEqual(["Ada", "Bea", "Zoe"]);
  });
});

describe("from < rootT resync persists the dump", () => {
  test("replaceConfirmed writes the dump bytes, not a stubbed skip", async () => {
    const store = memoryStore();
    const world = await schemaConn();
    await world.transact([{ ":user/name": "Ada" }]);
    await world.transact([{ ":user/name": "Bea" }]);
    const dump = await snapshotDatoms(world);
    expect(dump.some((d) => d[3] === "Ada")).toBe(true);
    expect(dump.some((d) => d[3] === "Bea")).toBe(true);

    const stale: OverlaySnap = {
      v: 1,
      confirmedT: 2,
      confirmed: [],
      pending: [],
    };
    await store.put("overlay.movies", encodeSnap(stale));

    const session = fakeSession({
      onSync: (from) => {
        expect(from).toBe(2);
        return {
          body: { t: world.t, from },
          push: { op: "resync", t: world.t, datoms: dump },
        };
      },
    });
    const overlay = openOverlay({
      session,
      post: () => Effect.succeed({}),
      catalog: Movies,
      store,
      name: "movies",
    });
    await run(overlay.ready());
    await until(() => overlay.confirmedT === world.t);
    expect(await namesOf(overlay)).toEqual(["Ada", "Bea"]);

    const persisted = await overlay.snapshot();
    expect(persisted.confirmedT).toBe(world.t);
    const names = persisted.confirmed
      .filter((d) => d[3] === "Ada" || d[3] === "Bea")
      .map((d) => d[3]);
    expect(names.sort()).toEqual(["Ada", "Bea"]);
    const raw = await store.get("overlay.movies");
    expect(raw).toBeDefined();
    const disk = JSON.parse(new TextDecoder().decode(raw)) as OverlaySnap;
    expect(disk.confirmedT).toBe(world.t);
    expect(disk.confirmed.some((d) => d[3] === "Ada")).toBe(true);
    expect(disk.confirmed.some((d) => d[3] === "Bea")).toBe(true);
  });
});

describe("the worker specifier exists", () => {
  test("follows this module's emit; dist looks for .js, not .ts", () => {
    const url = followerWorkerUrl();
    expect(url.pathname.endsWith("follower-worker.ts")).toBe(true);
    expect(existsSync(fileURLToPath(url))).toBe(true);
    expect(
      followerWorkerUrlBeside("file:///pkg/dist/db/follower.js").pathname.endsWith(
        "follower-worker.js",
      ),
    ).toBe(true);
    expect(
      followerWorkerUrlBeside("file:///pkg/src/db/follower.ts").pathname.endsWith(
        "follower-worker.ts",
      ),
    ).toBe(true);
  });
});

describe("a dead SharedWorker is not a follower", () => {
  const silentPort = () => ({
    start() {},
    postMessage() {},
    addEventListener() {},
    removeEventListener() {},
    close() {},
  });

  test("constructor success + no reply falls through to the one in-page overlay", async () => {
    let constructed = 0;
    class SilentSharedWorker {
      readonly port = silentPort();
      constructor() {
        constructed += 1;
      }
      addEventListener() {}
    }
    const peer = fakePeer({
      answer: () => ({ body: { t: 0, result: [] } }),
    });
    const g = globalThis as {
      SharedWorker?: unknown;
      WebSocket: typeof WebSocket;
    };
    const prevSW = g.SharedWorker;
    const prevWS = g.WebSocket;
    g.SharedWorker = SilentSharedWorker;
    g.WebSocket = peer.webSocket;
    try {
      const { databases, close } = makeDatabases({
        url: Effect.succeed("https://peer.example.com"),
        fetch: fromStandardFetch(peer.fetch),
        webSocket: (url) => new peer.webSocket(url) as never,
        socketInjected: false,
        workerReadyMs: 40,
      });
      const rows = await run(
        databases.db("movies", Movies).q(query(User).select({ name: User.name })),
      );
      expect(constructed).toBeGreaterThan(0);
      expect(Array.isArray(rows)).toBe(true);
      expect(peer.sockets.length).toBeGreaterThan(0);
      close();
    } finally {
      if (prevSW === undefined) delete g.SharedWorker;
      else g.SharedWorker = prevSW;
      g.WebSocket = prevWS;
    }
  });

  test("a worker error event falls through without sitting on the handshake", async () => {
    class ErrorSharedWorker {
      readonly port = silentPort();
      onerror: ((ev: Event) => void) | null = null;
      constructor() {
        queueMicrotask(() => this.onerror?.(new Event("error")));
      }
      addEventListener(type: string, cb: (ev: Event) => void) {
        if (type === "error") this.onerror = cb;
      }
    }
    const peer = fakePeer({
      answer: () => ({ body: { t: 0, result: [] } }),
    });
    const g = globalThis as {
      SharedWorker?: unknown;
      WebSocket: typeof WebSocket;
    };
    const prevSW = g.SharedWorker;
    const prevWS = g.WebSocket;
    g.SharedWorker = ErrorSharedWorker;
    g.WebSocket = peer.webSocket;
    try {
      const { databases, close } = makeDatabases({
        url: Effect.succeed("https://peer.example.com"),
        fetch: fromStandardFetch(peer.fetch),
        webSocket: (url) => new peer.webSocket(url) as never,
        socketInjected: false,
        workerReadyMs: 4_000,
      });
      const started = Date.now();
      await run(
        databases.db("movies", Movies).q(query(User).select({ name: User.name })),
      );
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(peer.sockets.length).toBeGreaterThan(0);
      close();
    } finally {
      if (prevSW === undefined) delete g.SharedWorker;
      else g.SharedWorker = prevSW;
      g.WebSocket = prevWS;
    }
  });
});

describe("outbox drains on a successful walk", () => {
  test("hydrate with pending, sync succeeds, POST without flush()", async () => {
    const store = memoryStore();
    const world = await schemaConn();
    await world.transact([{ ":user/name": "Ada" }]);
    const dump = await snapshotDatoms(world);
    const nameA = world.db().schema.requireAttr(":user/name").id;
    const live = openOverlay({
      session: fakeSession(),
      post: () => Effect.fail(new NetworkError({ message: "offline" })),
      catalog: Movies,
      store,
      name: "movies",
    });
    await run(live.ready());
    await live.handlePush({ op: "resync", t: world.t, datoms: dump });
    await run(live.transact([{ ":user/name": "Bea" }]));
    expect((await live.snapshot()).pending).toHaveLength(1);

    const posted: string[] = [];
    const online = openOverlay({
      session: fakeSession({
        onSync: (from) => ({ body: { t: from, from } }),
      }),
      post: (tx, id) => {
        posted.push(id);
        return Effect.succeed({
          t: world.t + 1,
          txEid: 1,
          tempids: {},
          datoms: [
            toWireDatom({
              e: 4001,
              a: nameA,
              vt: ValueTag.Str,
              v: "Bea",
              t: world.t + 1,
              op: true,
            }),
          ],
          clientTxId: id,
        });
      },
      catalog: Movies,
      store,
      name: "movies",
    });
    expect(online).not.toBe(live);
    await run(online.ready());
    expect(await namesOf(online)).toEqual(["Ada", "Bea"]);
    await until(() => posted.length === 1);
    expect(posted).toHaveLength(1);
    expect((await online.snapshot()).pending).toHaveLength(0);
  });
});
