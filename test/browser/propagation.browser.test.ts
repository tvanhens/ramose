import { expect } from "vitest";
import { IndexedDbReplicaStorage } from "../../packages/ramose/src/internal/replication/indexeddb.ts";
import { replicaScopeOf } from "../../packages/ramose/src/internal/replication/replica-lifecycle.ts";
import { browserTest } from "./fixtures.ts";
import { openTab, type TabHandle } from "./tab-harness.ts";
import {
  CHILD_LINEAGE,
  CHILD_PATH,
  identityFor,
  noteDatoms,
  observeChildRoute,
  opaque,
  REVISION,
  seed,
  seedDatabases,
  workspaceDatoms,
} from "./propagation-tab.ts";

const tabModule = new URL("./propagation-tab.ts", import.meta.url).href;

type QueryReport = {
  readonly status: string;
  readonly titles: readonly string[];
  readonly pending: readonly boolean[];
};

type LoopReport = {
  readonly leadership: string;
  readonly passes: number;
  readonly planned: readonly string[];
  readonly overlapped: boolean;
  readonly resolved: readonly string[];
  readonly retired: readonly string[];
};

const dumpStore = async (
  name: string,
  store: string,
): Promise<readonly unknown[]> => {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name);
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });
  const transaction = database.transaction(store, "readonly");
  const records = await new Promise<unknown[]>((resolve, reject) => {
    const request = transaction.objectStore(store).getAll();
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });
  await new Promise<void>((resolve) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("abort", () => resolve(), { once: true });
  });
  database.close();
  return records;
};

const NOTES = [
  { entity: opaque("e"), title: "first", rank: "a" },
  { entity: opaque("f"), title: "second", rank: "b" },
] as const;

const NEXT_REVISION = "revision-two".padEnd(43, "0");
const THIRD_REVISION = "revision-three".padEnd(43, "0");

const deleteDatabase = (name: string): Promise<void> =>
  new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(name);
    request.addEventListener("success", () => resolve(), { once: true });
    request.addEventListener("error", () => resolve(), { once: true });
    request.addEventListener("blocked", () => resolve(), { once: true });
  });

const databaseOf = (uniqueId: string): string =>
  uniqueId.replaceAll("-", "").padEnd(43, "z").slice(0, 43);

const until = async <A>(
  probe: () => Promise<A>,
  ready: (value: A) => boolean,
  label: string,
  budget = 4_000,
): Promise<A> => {
  const deadline = performance.now() + budget;
  for (;;) {
    const value = await probe();
    if (ready(value)) return value;
    if (performance.now() > deadline) {
      throw new Error(`timed out waiting for ${label}: ${JSON.stringify(value)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const steady = async <A>(
  probe: () => Promise<A>,
  holds: (value: A) => boolean,
  label: string,
  attempts = 12,
): Promise<void> => {
  for (let attempt = 0; attempt < attempts; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const value = await probe();
    if (!holds(value)) {
      throw new Error(`${label} changed to ${JSON.stringify(value)}`);
    }
  }
};

const rendering = (tab: TabHandle): Promise<QueryReport> =>
  until(
    () => tab.call<QueryReport>("report"),
    (report) => report.status === "ready",
    "the first rendered value",
  );

const started = async (
  tab: TabHandle,
  storageName: string,
  database: string,
): Promise<QueryReport> => {
  await tab.call("start", { storageName, database });
  const rendered = await rendering(tab);
  await until(
    () => tab.call<string>("sync"),
    (status) => status === "offline",
    "the tab's own stream to end",
  );
  return rendered;
};

const titles = (tab: TabHandle): Promise<readonly string[]> =>
  tab.call<QueryReport>("report").then((report) => report.titles);

browserTest(
  "a committed change in one tab re-renders another tab's query",
  async ({ browser }) => {
    const name = `ramose-propagation-commit-${browser.uniqueId}`;
    const database = databaseOf(browser.uniqueId);
    await seed(name, await identityFor(database), NOTES);
    const leader = await openTab(tabModule);
    const follower = await openTab(tabModule);
    try {
      const rendered = await started(follower, name, database);
      expect(rendered.titles).toEqual(["first", "second"]);

      const started_at = performance.now();
      expect(
        await leader.call<string>("commit", {
          storageName: name,
          database,
          note: { entity: opaque("g"), title: "third", rank: "c" },
          from: REVISION,
          revision: NEXT_REVISION,
        }),
      ).toBe(NEXT_REVISION);

      const converged = await until(
        () => titles(follower),
        (rows) => rows.includes("third"),
        "the follower to render the committed change",
      );
      expect(converged).toEqual(["first", "second", "third"]);
      expect(performance.now() - started_at).toBeLessThan(2_000);
    } finally {
      await follower.close();
      await leader.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "consecutive committed changes never leave a tab on the earlier one",
  async ({ browser }) => {
    const name = `ramose-propagation-consecutive-${browser.uniqueId}`;
    const database = databaseOf(browser.uniqueId);
    await seed(name, await identityFor(database), NOTES);
    const leader = await openTab(tabModule);
    const follower = await openTab(tabModule);
    try {
      expect((await started(follower, name, database)).titles).toEqual([
        "first",
        "second",
      ]);

      expect(
        await leader.call<string>("commit", {
          storageName: name,
          database,
          note: { entity: opaque("g"), title: "third", rank: "c" },
          from: REVISION,
          revision: NEXT_REVISION,
          then: {
            note: { entity: opaque("i"), title: "fourth", rank: "d" },
            revision: THIRD_REVISION,
          },
        }),
      ).toBe(THIRD_REVISION);

      const converged = await until(
        () => titles(follower),
        (rows) => rows.includes("fourth"),
        "the follower to render the later change",
      );
      expect(converged).toEqual(["first", "second", "third", "fourth"]);

      await steady(
        () => titles(follower),
        (rows) => rows.includes("fourth"),
        "the follower's converged value",
      );
    } finally {
      await follower.close();
      await leader.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "a committed change reaches a tab with no channel on its next activation",
  async ({ browser }) => {
    const name = `ramose-propagation-suppressed-${browser.uniqueId}`;
    const database = databaseOf(browser.uniqueId);
    await seed(name, await identityFor(database), NOTES);
    const leader = await openTab(tabModule);
    const follower = await openTab(tabModule);
    try {
      expect(await follower.call<boolean>("withoutBroadcasts")).toBe(true);
      expect((await started(follower, name, database)).titles).toEqual([
        "first",
        "second",
      ]);

      await leader.call<string>("commit", {
        storageName: name,
        database,
        note: { entity: opaque("g"), title: "third", rank: "c" },
        from: REVISION,
        revision: NEXT_REVISION,
      });

      await steady(
        () => titles(follower),
        (rows) => !rows.includes("third"),
        "the unnotified tab's value",
      );

      follower.wake();

      const converged = await until(
        () => titles(follower),
        (rows) => rows.includes("third"),
        "the reactivated tab to read the durable head",
      );
      expect(converged).toEqual(["first", "second", "third"]);
    } finally {
      await follower.close();
      await leader.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "one tab's optimistic layer becomes visible in the other tab",
  async ({ browser }) => {
    const name = `ramose-propagation-layer-${browser.uniqueId}`;
    const database = databaseOf(browser.uniqueId);
    await seed(name, await identityFor(database), NOTES);
    const writer = await openTab(tabModule);
    const reader = await openTab(tabModule);
    try {
      await started(writer, name, database);
      await started(reader, name, database);

      expect(await writer.call<string>("rename", { from: "first", to: "renamed" }))
        .toMatch(/./);

      const moved = await until(
        () => reader.call<QueryReport>("report"),
        (report) => report.titles.includes("renamed"),
        "the other tab to render the optimistic layer",
      );
      expect(moved.titles).toEqual(["renamed", "second"]);
      expect(moved.pending[0]).toBe(true);
      expect(await writer.call<string>("receipt")).toBe("queued");
    } finally {
      await reader.close();
      await writer.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "an optimistic layer reaches an unnotified tab on its next activation",
  async ({ browser }) => {
    const name = `ramose-propagation-layer-suppressed-${browser.uniqueId}`;
    const database = databaseOf(browser.uniqueId);
    await seed(name, await identityFor(database), NOTES);
    const writer = await openTab(tabModule);
    const reader = await openTab(tabModule);
    try {
      expect(await reader.call<boolean>("withoutBroadcasts")).toBe(true);
      await started(writer, name, database);
      await started(reader, name, database);

      await writer.call<string>("rename", { from: "first", to: "renamed" });
      await steady(
        () => titles(reader),
        (rows) => !rows.includes("renamed"),
        "the unnotified tab's value",
      );

      reader.wake();
      expect(
        await until(
          () => titles(reader),
          (rows) => rows.includes("renamed"),
          "the reactivated tab to read the durable layers",
        ),
      ).toEqual(["renamed", "second"]);
    } finally {
      await reader.close();
      await writer.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "a follower's enqueue wakes the leader's submission loop",
  async ({ browser }) => {
    const name = `ramose-propagation-wakeup-${browser.uniqueId}`;
    const database = databaseOf(browser.uniqueId);
    await seed(name, await identityFor(database), NOTES);
    const leader = await openTab(tabModule);
    const follower = await openTab(tabModule);
    try {
      await leader.call<LoopReport>("lead", { storageName: name, database });
      await until(
        () => leader.call<LoopReport>("loop"),
        (loop) => loop.leadership === "leading",
        "leadership",
      );
      const before = await leader.call<LoopReport>("settle");

      const at = performance.now();
      await follower.call("enqueue", { storageName: name, database, title: "queued" });

      const woken = await until(
        () => leader.call<LoopReport>("loop"),
        (loop) => loop.planned.length > before.planned.length,
        "the leader to plan the follower's queued work",
      );
      expect(performance.now() - at).toBeLessThan(1_000);
      expect(woken.planned).toContain(database);
    } finally {
      await follower.close();
      await leader.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "a follower's graph child enqueue reaches the leader's submission loop",
  async ({ browser }) => {
    const name = `ramose-propagation-child-${browser.uniqueId}`;
    const database = databaseOf(browser.uniqueId);
    const child = `child-${databaseOf(browser.uniqueId)}`.slice(0, 43).padEnd(43, "z");
    await seed(name, await identityFor(database), NOTES);
    const leader = await openTab(tabModule);
    const follower = await openTab(tabModule);
    try {
      await leader.call<LoopReport>("lead", { storageName: name, database });
      await until(
        () => leader.call<LoopReport>("loop"),
        (loop) => loop.leadership === "leading",
        "leadership",
      );
      await leader.call<LoopReport>("settle");

      await follower.call("enqueue", {
        storageName: name,
        database,
        child,
        title: "queued",
      });

      const woken = await until(
        () => leader.call<LoopReport>("loop"),
        (loop) => loop.planned.includes(child),
        "the leader to plan the follower's graph child",
      );
      expect(woken.planned).toContain(child);
    } finally {
      await follower.close();
      await leader.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "the leader resolves a follower's graph child from the durable record",
  async ({ browser }) => {
    const name = `ramose-propagation-receiver-${browser.uniqueId}`;
    const database = databaseOf(browser.uniqueId);
    const childId = `c${database}`.slice(0, 43);
    const child = await identityFor(childId, CHILD_LINEAGE);
    await seedDatabases(name, [
      {
        identity: await identityFor(database),
        datoms: [...noteDatoms(NOTES), ...workspaceDatoms(CHILD_LINEAGE[0]!)],
      },
      {
        identity: child,
        datoms: noteDatoms([{ entity: opaque("g"), title: "child", rank: "a" }]),
        graphPath: CHILD_PATH,
        observeRoute: true,
      },
    ]);
    const leader = await openTab(tabModule);
    const follower = await openTab(tabModule);
    try {
      await leader.call<LoopReport>("lead", { storageName: name, database });
      await until(
        () => leader.call<LoopReport>("loop"),
        (loop) => loop.leadership === "leading",
        "leadership",
      );
      await leader.call<LoopReport>("settle");

      await follower.call("enqueue", {
        storageName: name,
        database,
        child: childId,
        title: "queued",
      });

      const woken = await until(
        () => leader.call<LoopReport>("loop"),
        (loop) => loop.resolved.length > 0,
        "the leader to resolve the receiver from its durable record",
      );
      expect(woken.planned).toContain(childId);
      expect(woken.resolved).toContain(CHILD_PATH.join("/"));
    } finally {
      await follower.close();
      await leader.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "a receiver whose path was renamed keeps the queue the old database owns",
  async ({ browser }) => {
    const name = `ramose-propagation-renamed-${browser.uniqueId}`;
    const database = databaseOf(browser.uniqueId);
    const before = `c${database}`.slice(0, 43);
    const after = `d${database}`.slice(0, 43);
    await seedDatabases(name, [
      {
        identity: await identityFor(database),
        datoms: [...noteDatoms(NOTES), ...workspaceDatoms(CHILD_LINEAGE[0]!)],
      },
      {
        identity: await identityFor(before, CHILD_LINEAGE),
        datoms: noteDatoms([{ entity: opaque("g"), title: "before", rank: "a" }]),
        graphPath: CHILD_PATH,
        observeRoute: true,
      },
    ]);
    const reader = await openTab(tabModule);
    try {
      const storage = await IndexedDbReplicaStorage.open(name);
      try {
        const receiver = { ...replicaScopeOf(await identityFor(database)), database: before };
        expect((await storage.graphReceiver(receiver))?.graphPath)
          .toEqual([...CHILD_PATH]);

        await seedDatabases(name, [{
          identity: await identityFor(after, CHILD_LINEAGE),
          datoms: noteDatoms([{ entity: opaque("h"), title: "after", rank: "a" }]),
          graphPath: CHILD_PATH,
          observeRoute: true,
        }]);
        expect((await storage.graphReceiver(receiver))?.graphPath)
          .toEqual([...CHILD_PATH]);
        expect(
          (await storage.graphReceiver({ ...receiver, database: after }))?.graphPath,
        ).toEqual([...CHILD_PATH]);
      } finally {
        storage.close();
      }

      await reader.call("enqueue", {
        storageName: name,
        database,
        child: before,
        title: "queued",
      });
      await steady(
        async () => (await dumpStore(name, "mutation-receipts-v1") as readonly {
          readonly state: string;
        }[]).map((receipt) => receipt.state),
        (states) => states.every((state) => state === "queued"),
        "the queue of the renamed receiver",
      );
    } finally {
      await reader.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "a follower's receipt settles from the leader's durable acknowledgement",
  async ({ browser }) => {
    const name = `ramose-propagation-receipt-${browser.uniqueId}`;
    const database = databaseOf(browser.uniqueId);
    const identity = await identityFor(database);
    await seed(name, identity, NOTES);
    const follower = await openTab(tabModule);
    const leader = await IndexedDbReplicaStorage.open(name);
    try {
      await started(follower, name, database);
      await follower.call<string>("rename", { from: "first", to: "renamed" });
      expect(await follower.call<string>("receipt")).toBe("queued");

      const queued = await leader.outbox().restore(replicaScopeOf(identity));
      expect(queued.records).toHaveLength(1);
      const receipt = await leader.outbox().acknowledge(
        queued.records[0]!,
        { _tag: "Committed", output: {}, mappings: [] },
        Date.now(),
      );
      expect(receipt.state).toBe("committed");

      expect(
        await until(
          () => follower.call<string>("receipt"),
          (status) => status === "committed",
          "the follower's receipt to settle",
        ),
      ).toBe("committed");
    } finally {
      leader.close();
      await follower.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "a route another tab confirms resolves this tab's graph child",
  async ({ browser }) => {
    const name = `ramose-propagation-route-${browser.uniqueId}`;
    const database = databaseOf(browser.uniqueId);
    const child = await identityFor(`c${database}`.slice(0, 43), CHILD_LINEAGE);
    await seedDatabases(name, [
      {
        identity: await identityFor(database),
        datoms: [...noteDatoms(NOTES), ...workspaceDatoms(opaque("w"))],
      },
      {
        identity: child,
        graphPath: CHILD_PATH,
        datoms: noteDatoms([{ entity: opaque("h"), title: "child", rank: "a" }]),
        observeRoute: false,
      },
    ]);
    const follower = await openTab(tabModule);
    try {
      await follower.call("startChild", { storageName: name, database });
      await until(
        () => follower.call<string>("sync"),
        (status) => status === "offline",
        "the tab's own stream to end",
      );

      await steady(
        () => follower.call<QueryReport>("report"),
        (report) => report.status === "pending",
        "the unresolved child query",
      );

      await observeChildRoute(name, child);

      const resolved = await until(
        () => follower.call<QueryReport>("report"),
        (report) => report.status === "ready",
        "the child to resolve from the confirmed route",
      );
      expect(resolved.titles).toEqual(["child"]);
    } finally {
      await follower.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "a storm of enqueue notices runs coalesced passes that never overlap",
  async ({ browser }) => {
    const name = `ramose-propagation-storm-${browser.uniqueId}`;
    const database = databaseOf(browser.uniqueId);
    const identity = await identityFor(database);
    await seed(name, identity, NOTES);
    const leader = await openTab(tabModule);
    const follower = await openTab(tabModule);
    const observer = await IndexedDbReplicaStorage.open(name);
    try {
      await leader.call<LoopReport>("lead", { storageName: name, database });
      await until(
        () => leader.call<LoopReport>("loop"),
        (loop) => loop.leadership === "leading",
        "leadership",
      );

      expect(
        await follower.call<number>("enqueue", {
          storageName: name,
          database,
          title: "queued",
          count: 30,
        }),
      ).toBe(30);

      await until(
        () => leader.call<LoopReport>("loop"),
        (loop) => loop.passes > 0,
        "the leader to run a pass",
      );
      const settled = await leader.call<LoopReport>("settle");
      const restored = await observer.outbox().restore(replicaScopeOf(identity));
      expect(restored.records).toHaveLength(30);
      expect(settled.overlapped).toBe(false);
      expect(settled.passes).toBeLessThan(30);
      expect(settled.passes).toBeGreaterThan(0);
    } finally {
      observer.close();
      await follower.close();
      await leader.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "a receiver record written after the queue was planned reschedules its pass",
  async ({ browser }) => {
    const name = `ramose-propagation-reschedule-${browser.uniqueId}`;
    const database = databaseOf(browser.uniqueId);
    const childId = `c${database}`.slice(0, 43);
    await seedDatabases(name, [{
      identity: await identityFor(database),
      datoms: [...noteDatoms(NOTES), ...workspaceDatoms(CHILD_LINEAGE[0]!)],
    }]);
    const tab = await openTab(tabModule);
    try {
      await started(tab, name, database);
      const activated = await tab.call<number>("presented");
      await tab.call("enqueue", {
        storageName: name,
        database,
        child: childId,
        title: "queued",
      });
      const planned = await until(
        () => tab.call<number>("presented"),
        (presented) => presented > activated,
        "the client's own pass over the child's queue",
      );
      await steady(
        () => tab.call<number>("presented"),
        (presented) => presented === planned,
        "the credential presentations of a queue with no receiver record",
      );

      await observeChildRoute(name, await identityFor(childId, CHILD_LINEAGE));
      const rescheduled = await until(
        () => tab.call<number>("presented"),
        (presented) => presented >= planned + 2,
        "the pass the receiver record reschedules, and the errand it activates",
      );

      await steady(
        () => tab.call<number>("presented"),
        (presented) => presented === rescheduled,
        "the credential presentations of a settled queue",
      );
      await tab.call("enqueue", {
        storageName: name,
        database,
        child: childId,
        title: "queued again",
      });
      await until(
        () => tab.call<number>("presented"),
        (presented) => presented >= rescheduled + 2,
        "the next pass reactivating the errand whose activation failed",
      );
    } finally {
      await tab.close();
      await deleteDatabase(name);
    }
  },
);
