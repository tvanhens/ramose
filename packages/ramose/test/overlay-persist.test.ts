/**
 * In-page overlay persist: memory is the current-view store, OPFS/bytes
 * are behind notify, pending is the outbox. No SharedWorker, no port
 * protocol, no second overlay.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { fromStandardFetch } from "../src/db/http.ts";
import { query } from "../src/db/NavQuery.ts";
import { openOverlay, type Overlay } from "../src/db/overlay.ts";
import {
  type ByteStore,
  decodeMeta,
  encodeMeta,
  loadSnap,
  logKey,
  memoryStore,
  persistKey,
} from "../src/db/persist.ts";
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

const until = async (
  pred: () => boolean | Promise<boolean>,
  ms = 2_000,
): Promise<void> => {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > ms) throw new Error("until timed out");
    await Bun.sleep(5);
  }
};

const fakeSession = (opts?: {
  readonly onSync?: (from: number) =>
    | {
        readonly body: unknown;
        readonly push?: Record<string, unknown>;
        readonly pushes?: readonly Record<string, unknown>[];
      }
    | Promise<{
        readonly body: unknown;
        readonly push?: Record<string, unknown>;
        readonly pushes?: readonly Record<string, unknown>[];
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
        if (got.pushes !== undefined) {
          for (const next of got.pushes) pusher(next);
        }
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
    await until(async () => {
      const loaded = await loadSnap(store, "movies");
      return loaded !== undefined && loaded.confirmedT === rootT;
    });
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
    expect(live.some((n) => n.length === 0)).toBe(false);
    expect(live.every((n) => n.includes("Ada"))).toBe(true);
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

describe("opening walk is one catch-up notify", () => {
  test("many {op:tx} during the walk notify once; a later tx notifies once", async () => {
    const store = memoryStore();
    const world = await schemaConn();
    await world.transact([{ ":user/name": "Ada" }]);
    const dump = await snapshotDatoms(world);
    const rootT = world.t;
    const nameA = world.db().schema.requireAttr(":user/name").id;
    const walked = ["Bea", "Cal", "Dot"].map((name, i) =>
      toWireDatom({
        e: 50_001 + i,
        a: nameA,
        vt: ValueTag.Str,
        v: name,
        t: rootT + 10 + i,
        op: true,
      }),
    );
    const tip = rootT + 10 + walked.length - 1;

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
    await until(async () => {
      const loaded = await loadSnap(store, "movies");
      return loaded !== undefined && loaded.confirmedT === rootT;
    });

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const session = fakeSession({
      onSync: async (from) => {
        await held;
        return {
          body: { t: tip, from },
          pushes: walked.map((datom, i) => ({
            op: "tx",
            t: rootT + 10 + i,
            datoms: [datom],
          })),
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
    const ticks: number[] = [];
    overlay.onChange(() => {
      ticks.push(overlay.epoch);
    });
    await run(overlay.ready());
    expect(await namesOf(overlay)).toEqual(["Ada"]);
    expect(ticks).toHaveLength(1);
    release();
    await until(() => ticks.length === 2);
    expect(ticks).toHaveLength(2);
    expect(await namesOf(overlay)).toEqual(["Ada", "Bea", "Cal", "Dot"]);

    await overlay.handlePush({
      op: "tx",
      t: tip + 1,
      datoms: [
        toWireDatom({
          e: 4001,
          a: nameA,
          vt: ValueTag.Str,
          v: "Eve",
          t: tip + 1,
          op: true,
        }),
      ],
    });
    expect(ticks).toHaveLength(3);
    expect(await namesOf(overlay)).toEqual(["Ada", "Bea", "Cal", "Dot", "Eve"]);
  });
});

describe("transact is not on the catch-up persist queue", () => {
  test("Bea is on view / live before the walk's OPFS writes finish", async () => {
    const memory = memoryStore();
    const world = await schemaConn();
    await world.transact([{ ":user/name": "Ada" }]);
    const dump = await snapshotDatoms(world);
    const rootT = world.t;
    const nameA = world.db().schema.requireAttr(":user/name").id;
    const walked = toWireDatom({
      e: 50_001,
      a: nameA,
      vt: ValueTag.Str,
      v: "Cal",
      t: rootT + 10,
      op: true,
    });

    const seed = openOverlay({
      session: fakeSession(),
      post: () => Effect.succeed({}),
      catalog: Movies,
      store: memory,
      name: "movies",
    });
    await run(seed.ready());
    await seed.handlePush({ op: "resync", t: rootT, datoms: dump });
    await until(async () => (await loadSnap(memory, "movies")) !== undefined);

    let holdPuts = true;
    let waitingPuts = 0;
    let releasePuts!: () => void;
    const putsHeld = new Promise<void>((resolve) => {
      releasePuts = resolve;
    });
    const store: ByteStore = {
      get: (key) => memory.get(key),
      put: async (key, value) => {
        if (holdPuts) {
          waitingPuts += 1;
          await putsHeld;
        }
        await memory.put(key, value);
      },
    };

    let releaseWalk!: () => void;
    const walkHeld = new Promise<void>((resolve) => {
      releaseWalk = resolve;
    });
    let session!: ReturnType<typeof fakeSession>;
    session = fakeSession({
      onSync: async (from) => {
        session.pusher({
          op: "tx",
          t: rootT + 10,
          datoms: [walked],
        });
        await until(() => waitingPuts >= 1);
        await walkHeld;
        return { body: { t: rootT + 10, from } };
      },
    });
    const overlay = openOverlay({
      session,
      post: () => Effect.fail(new NetworkError({ message: "offline" })),
      catalog: Movies,
      store,
      name: "movies",
    });
    const ticks: number[] = [];
    overlay.onChange(() => {
      ticks.push(overlay.epoch);
    });
    await run(overlay.ready());
    expect(ticks).toHaveLength(1);
    expect(await namesOf(overlay)).toContain("Ada");
    await until(() => waitingPuts >= 1);

    await run(overlay.transact([{ ":user/name": "Bea" }]));
    expect(await namesOf(overlay)).toContain("Bea");
    expect(ticks).toHaveLength(2);
    expect(waitingPuts).toBeGreaterThan(0);

    releaseWalk();
    await until(() => ticks.length === 3);
    expect(ticks).toHaveLength(3);
    expect(await namesOf(overlay)).toEqual(["Ada", "Bea", "Cal"]);
    holdPuts = false;
    releasePuts();
  });
});

describe("persist does not block notify", () => {
  test("onChange fires before store.put resolves", async () => {
    const memory = memoryStore();
    let holdPuts = false;
    let releasePuts = (): void => {};
    let putsHeld = Promise.resolve();
    let putResolved = 0;
    const store: ByteStore = {
      get: (key) => memory.get(key),
      put: async (key, value) => {
        if (holdPuts) await putsHeld;
        await memory.put(key, value);
        putResolved += 1;
      },
    };

    const world = await schemaConn();
    await world.transact([{ ":user/name": "Ada" }]);
    const dump = await snapshotDatoms(world);
    const nameA = world.db().schema.requireAttr(":user/name").id;
    const overlay = openOverlay({
      session: fakeSession(),
      post: () => Effect.succeed({}),
      catalog: Movies,
      store,
      name: "movies",
    });
    await run(overlay.ready());
    await overlay.handlePush({ op: "resync", t: world.t, datoms: dump });
    await until(() => putResolved >= 1);

    holdPuts = true;
    putsHeld = new Promise<void>((resolve) => {
      releasePuts = resolve;
    });
    const resolved = putResolved;
    let notified = 0;
    overlay.onChange(() => {
      notified += 1;
    });
    const inbound = overlay.handlePush({
      op: "tx",
      t: world.t + 1,
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
    });
    expect(notified).toBe(1);
    expect(putResolved).toBe(resolved);
    expect(await namesOf(overlay)).toEqual(["Ada", "Bea"]);
    releasePuts();
    await inbound;
    await until(() => putResolved > resolved);
    expect(notified).toBe(1);
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
        return Effect.fail(new NetworkError({ message: "offline" }));
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

    await until(async () => {
      const bytes = await store.get(persistKey("movies"));
      return bytes !== undefined && (decodeMeta(bytes)?.pending.length ?? 0) === 1;
    });
    const bytes = await store.get(persistKey("movies"));
    expect(bytes).toBeDefined();
    const decoded = decodeMeta(bytes!);
    expect(decoded?.pending).toHaveLength(1);
    expect(decoded && "confirmed" in decoded).toBe(false);

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

describe("resync rebases pending, it does not wipe", () => {
  test("hydrate/move pending Bea, dump of Ada — Bea stays on view / live", async () => {
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
    expect(await namesOf(live)).toEqual(["Ada", "Bea"]);
    const before = await live.snapshot();
    expect(before.pending).toHaveLength(1);
    const beaId = before.pending[0]!.clientTxId;

    const ticks: number[] = [];
    const liveNames: string[][] = [];
    live.onChange(() => {
      ticks.push(live.epoch);
      void namesOf(live).then((n) => liveNames.push(n));
    });

    await live.handlePush({ op: "resync", t: world.t, datoms: dump });
    expect(await namesOf(live)).toEqual(["Ada", "Bea"]);
    await until(() => liveNames.some((n) => n.includes("Bea")));
    expect(liveNames.at(-1)).toEqual(["Ada", "Bea"]);
    const after = await live.snapshot();
    expect(after.pending).toHaveLength(1);
    expect(after.pending[0]!.clientTxId).toBe(beaId);
    expect(after.confirmed.some((d) => d[3] === "Ada")).toBe(true);
    expect(after.confirmed.some((d) => d[3] === "Bea")).toBe(false);
    expect(ticks.length).toBeGreaterThan(0);

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
    expect(await namesOf(reloaded)).toEqual(["Ada", "Bea"]);
    expect((await reloaded.snapshot()).pending[0]!.clientTxId).toBe(beaId);
  });

  test("transact during a dump persist notifies Bea before store.put resolves", async () => {
    const memory = memoryStore();
    let holdPuts = false;
    let waitingPuts = 0;
    let releasePuts!: () => void;
    const putsHeld = new Promise<void>((resolve) => {
      releasePuts = resolve;
    });
    const store: ByteStore = {
      get: (key) => memory.get(key),
      put: async (key, value) => {
        if (holdPuts) {
          waitingPuts += 1;
          await putsHeld;
        }
        await memory.put(key, value);
      },
    };

    const world = await schemaConn();
    await world.transact([{ ":user/name": "Ada" }]);
    const dump = await snapshotDatoms(world);

    const overlay = openOverlay({
      session: fakeSession(),
      post: () => Effect.fail(new NetworkError({ message: "offline" })),
      catalog: Movies,
      store,
      name: "movies",
    });
    await run(overlay.ready());
    await overlay.handlePush({ op: "resync", t: world.t, datoms: dump });
    expect(await namesOf(overlay)).toEqual(["Ada"]);

    holdPuts = true;
    const dumpP = overlay.handlePush({
      op: "resync",
      t: world.t,
      datoms: dump,
    });
    await until(() => waitingPuts >= 1);

    const paints: string[][] = [];
    overlay.onChange(() => {
      void namesOf(overlay).then((n) => paints.push(n));
    });

    await run(overlay.transact([{ ":user/name": "Bea" }]));
    expect(await namesOf(overlay)).toEqual(["Ada", "Bea"]);
    await until(() => paints.some((n) => n.includes("Bea")));
    expect(paints.some((n) => n.includes("Bea"))).toBe(true);
    expect((await overlay.snapshot()).pending).toHaveLength(1);

    holdPuts = false;
    releasePuts();
    await dumpP;
    expect(await namesOf(overlay)).toEqual(["Ada", "Bea"]);
    expect((await overlay.snapshot()).pending).toHaveLength(1);
  });
});

describe("from < rootT resync persists the dump", () => {
  test("cursor-only snap is first paint; the dump is the next epoch", async () => {
    const store = memoryStore();
    const world = await schemaConn();
    await world.transact([{ ":user/name": "Ada" }]);
    await world.transact([{ ":user/name": "Bea" }]);
    const dump = await snapshotDatoms(world);
    expect(dump.some((d) => d[3] === "Ada")).toBe(true);
    expect(dump.some((d) => d[3] === "Bea")).toBe(true);

    await store.put(
      persistKey("movies"),
      encodeMeta({ v: 2, confirmedT: 2, ts: [], pending: [] }),
    );

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const session = fakeSession({
      onSync: async (from) => {
        expect(from).toBe(2);
        await held;
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
    const ticks: number[] = [];
    overlay.onChange(() => {
      ticks.push(overlay.epoch);
    });
    await run(overlay.ready());
    expect(overlay.confirmedT).toBe(2);
    expect(await namesOf(overlay)).toEqual([]);
    expect(ticks).toHaveLength(1);

    release();
    await until(() => ticks.length === 2);
    expect(ticks).toHaveLength(2);
    expect(overlay.confirmedT).toBe(world.t);
    expect(await namesOf(overlay)).toEqual(["Ada", "Bea"]);

    const persisted = await overlay.snapshot();
    expect(persisted.confirmedT).toBe(world.t);
    const names = persisted.confirmed
      .filter((d) => d[3] === "Ada" || d[3] === "Bea")
      .map((d) => d[3]);
    expect(names.sort()).toEqual(["Ada", "Bea"]);
    await until(async () => {
      const snap = await loadSnap(store, "movies");
      return (
        snap !== undefined &&
        snap.confirmedT === world.t &&
        snap.confirmed.some((d) => d[3] === "Ada") &&
        snap.confirmed.some((d) => d[3] === "Bea")
      );
    });
    const disk = await loadSnap(store, "movies");
    expect(disk?.confirmedT).toBe(world.t);
    expect(disk?.confirmed.some((d) => d[3] === "Ada")).toBe(true);
    expect(disk?.confirmed.some((d) => d[3] === "Bea")).toBe(true);
    const metaBytes = await store.get(persistKey("movies"));
    expect(metaBytes).toBeDefined();
    const meta = decodeMeta(metaBytes!);
    expect(meta?.ts.length).toBeGreaterThan(0);
    expect(meta && "confirmed" in meta).toBe(false);
    const firstT = meta!.ts[0]!;
    expect(await store.get(logKey("movies", firstT))).toBeDefined();
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
      post: (_tx, id) => {
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

describe("one client mode — the page, not a worker", () => {
  test("SharedWorker constructor is never used", async () => {
    let constructed = 0;
    class FakeSharedWorker {
      readonly port = {
        start() {},
        postMessage() {},
        addEventListener() {},
        removeEventListener() {},
        close() {},
      };
      constructor() {
        constructed += 1;
      }
    }
    const peer = fakePeer({
      answer: () => ({ body: { t: 0, result: [] } }),
    });
    const g = globalThis as { SharedWorker?: unknown; WebSocket: typeof WebSocket };
    const prevSW = g.SharedWorker;
    const prevWS = g.WebSocket;
    g.SharedWorker = FakeSharedWorker;
    g.WebSocket = peer.webSocket;
    try {
      const { databases, close } = makeDatabases({
        url: Effect.succeed("https://peer.example.com"),
        fetch: fromStandardFetch(peer.fetch),
        webSocket: (url) => new peer.webSocket(url) as never,
      });
      const rows = await run(
        databases.db("movies", Movies).q(query(User).select({ name: User.name })),
      );
      expect(Array.isArray(rows)).toBe(true);
      expect(constructed).toBe(0);
      expect(peer.sockets.length).toBeGreaterThan(0);
      close();
    } finally {
      if (prevSW === undefined) delete g.SharedWorker;
      else g.SharedWorker = prevSW;
      g.WebSocket = prevWS;
    }
  });

  test("no SharedWorker / follower-worker / port protocol in the client tree", async () => {
    const files = [
      new URL("../src/db/overlay.ts", import.meta.url),
      new URL("../src/db/persist.ts", import.meta.url),
      new URL("../src/db/Databases.ts", import.meta.url),
      new URL("../src/react/RamoseProvider.tsx", import.meta.url),
    ];
    for (const url of files) {
      const src = await readFile(url, "utf8");
      expect(src).not.toMatch(/SharedWorker/);
      expect(src).not.toMatch(/follower-worker/);
      expect(src).not.toMatch(/openFollower/);
      expect(src).not.toMatch(/port-client/);
    }
  });
});
