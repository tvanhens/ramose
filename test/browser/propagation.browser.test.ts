import { expect } from "vitest";
import { IndexedDbReplicaStorage } from "../../packages/ramose/src/internal/replication/indexeddb.ts";
import {
  replicaDatabaseScopeOf,
  replicaScopeOf,
} from "../../packages/ramose/src/internal/replication/replica-lifecycle.ts";
import { changeFrame } from "../../packages/ramose/test/replication-fixtures.ts";
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

const stripSettlements = async (name: string): Promise<number> => {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name);
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });
  const stores = ["mutation-layers-v1", "mutation-receipts-v1"];
  const transaction = database.transaction(stores, "readwrite");
  let stripped = 0;
  for (const store of stores) {
    const target = transaction.objectStore(store);
    const records = await new Promise<unknown[]>((resolve, reject) => {
      const request = target.getAll();
      request.addEventListener("success", () => resolve(request.result), { once: true });
      request.addEventListener("error", () => reject(request.error), { once: true });
    });
    for (const record of records) {
      const value = record as Record<string, unknown>;
      if (value.settled === undefined) continue;
      delete value.settled;
      target.put(value);
      stripped++;
    }
  }
  await new Promise<void>((resolve) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("abort", () => resolve(), { once: true });
  });
  database.close();
  return stripped;
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

const renamed = (
  entity: string,
  from: string,
  to: string,
): readonly {
  readonly entity: string;
  readonly field: string;
  readonly value: { readonly type: "string"; readonly value: string };
  readonly op: "add" | "retract";
}[] => [
  { entity, field: ":note/title", value: { type: "string", value: from }, op: "retract" },
  { entity, field: ":note/title", value: { type: "string", value: to }, op: "add" },
];

const regressions = (
  history: readonly QueryReport[],
  left: readonly string[],
  reached: string,
): readonly (readonly string[])[] => {
  const moved = history.findIndex((report) => report.titles.includes(reached));
  if (moved < 0) return [];
  return history.slice(moved + 1)
    .filter((report) => left.some((title) => report.titles.includes(title)))
    .map((report) => report.titles);
};

const monotone = async (
  tab: TabHandle,
  label: string,
  left: readonly string[],
  reached: string,
): Promise<void> => {
  expect(
    regressions(await tab.call<readonly QueryReport[]>("published"), left, reached),
    `${label} rendered a position the card had already left`,
  ).toEqual([]);
};

browserTest(
  "a fenced layer never returns a tab to the position the card left",
  async ({ browser }) => {
    const name = `ramose-propagation-fence-snapback-${browser.uniqueId}`;
    const database = databaseOf(browser.uniqueId);
    const identity = await identityFor(database);
    await seed(name, identity, NOTES);
    const writer = await openTab(tabModule);
    const reader = await openTab(tabModule);
    const leader = await IndexedDbReplicaStorage.open(name);
    try {
      await started(writer, name, database);
      await started(reader, name, database);

      await writer.call<string>("rename", { from: "first", to: "moved" });
      for (const [tab, label] of [[writer, "the writer"], [reader, "the reader"]] as const) {
        expect(
          await until(
            () => titles(tab),
            (rows) => rows.includes("moved"),
            `${label} to render the optimistic layer`,
          ),
        ).toEqual(["moved", "second"]);
      }

      const receiver = replicaDatabaseScopeOf(identity);
      const queued = await leader.outbox().restore(replicaScopeOf(identity));
      expect(queued.records).toHaveLength(1);
      expect(
        (await leader.outbox().acknowledge(queued.records[0]!, {
          _tag: "Committed",
          settled: 1,
          output: {},
          mappings: [],
        })).state,
      ).toBe("committed");
      expect(
        await until(
          () => writer.call<string>("receipt"),
          (status) => status === "committed",
          "the writer's receipt to settle",
        ),
      ).toBe("committed");

      const activation = await leader.outbox().beginActivation(receiver);
      await leader.outbox().fenceActivation(receiver, activation);
      expect(
        (await leader.outbox().receipt(receiver, queued.records[0]!.invocation))
          ?.observation,
      ).toBe("observed");

      await steady(
        async () => ({
          writer: await titles(writer),
          reader: await titles(reader),
        }),
        (rendered) =>
          [rendered.writer, rendered.reader].every((rows) =>
            rows.length === 0 || rows.includes("moved")
          ),
        "the rendered position after the fence",
        25,
      );
      await monotone(reader, "the reader", ["first"], "moved");
      await monotone(writer, "the writer", ["first"], "moved");

      const installed = await leader.applyChange(changeFrame({
        type: "Change",
        protocol: 4,
        identity,
        from: REVISION,
        revision: NEXT_REVISION,
        ordinal: 2,
        settled: 1,
        datoms: renamed(NOTES[0]!.entity, "first", "moved"),
      }));
      installed?.release();

      for (const [tab, label] of [[writer, "the writer"], [reader, "the reader"]] as const) {
        expect(
          await until(
            () => tab.call<QueryReport>("report"),
            (rendered) =>
              rendered.titles.includes("moved") && rendered.pending[0] === false,
            `${label} to converge on the committed position`,
          ),
        ).toMatchObject({ titles: ["moved", "second"], pending: [false, false] });
      }
      await monotone(reader, "the reader", ["first"], "moved");
      await monotone(writer, "the writer", ["first"], "moved");
    } finally {
      leader.close();
      await reader.close();
      await writer.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "a fence over the earlier layer keeps the later one the tabs already render",
  async ({ browser }) => {
    const name = `ramose-propagation-fence-partial-${browser.uniqueId}`;
    const database = databaseOf(browser.uniqueId);
    const identity = await identityFor(database);
    await seed(name, identity, NOTES);
    const writer = await openTab(tabModule);
    const reader = await openTab(tabModule);
    const leader = await IndexedDbReplicaStorage.open(name);
    try {
      await started(writer, name, database);
      await started(reader, name, database);

      await writer.call<string>("rename", { from: "first", to: "moved" });
      await until(
        () => titles(writer),
        (rows) => rows.includes("moved"),
        "the writer to render the first layer",
      );
      await writer.call<string>("rename", { from: "moved", to: "moved-again" });
      for (const [tab, label] of [[writer, "the writer"], [reader, "the reader"]] as const) {
        expect(
          await until(
            () => titles(tab),
            (rows) => rows.includes("moved-again"),
            `${label} to render the later layer`,
          ),
        ).toEqual(["moved-again", "second"]);
      }

      const receiver = replicaDatabaseScopeOf(identity);
      const queued = await leader.outbox().restore(replicaScopeOf(identity));
      expect(queued.records).toHaveLength(2);
      await leader.outbox().acknowledge(queued.records[0]!, {
        _tag: "Committed",
        settled: 1,
        output: {},
        mappings: [],
      });
      const activation = await leader.outbox().beginActivation(receiver);
      const fenced = await leader.outbox().fenceActivation(receiver, activation);
      expect(fenced.fenced).toEqual([queued.records[0]!.invocation]);
      expect(fenced.layers.map((layer) => layer.invocation))
        .toEqual([queued.records[1]!.invocation]);

      await steady(
        async () => ({
          writer: await titles(writer),
          reader: await titles(reader),
        }),
        (rendered) =>
          [rendered.writer, rendered.reader].every((rows) =>
            rows.length === 0 || rows.includes("moved-again")
          ),
        "the rendered position after the partial fence",
        25,
      );

      const installed = await leader.applyChange(changeFrame({
        type: "Change",
        protocol: 4,
        identity,
        from: REVISION,
        revision: NEXT_REVISION,
        ordinal: 2,
        settled: 1,
        datoms: renamed(NOTES[0]!.entity, "first", "moved"),
      }));
      installed?.release();

      for (const [tab, label] of [[writer, "the writer"], [reader, "the reader"]] as const) {
        expect(
          await until(
            () => tab.call<QueryReport>("report"),
            (rendered) => rendered.pending[0] === true,
            `${label} to render the later layer over the committed position`,
          ),
        ).toMatchObject({ titles: ["moved-again", "second"] });
        await monotone(tab, label, ["first", "moved"], "moved-again");
      }
    } finally {
      leader.close();
      await reader.close();
      await writer.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "a fence after the committed outcome arrived retires the layer at once",
  async ({ browser }) => {
    const name = `ramose-propagation-fence-outcome-${browser.uniqueId}`;
    const database = databaseOf(browser.uniqueId);
    const identity = await identityFor(database);
    await seed(name, identity, NOTES);
    const writer = await openTab(tabModule);
    const reader = await openTab(tabModule);
    const leader = await IndexedDbReplicaStorage.open(name);
    try {
      await started(writer, name, database);
      await started(reader, name, database);

      await writer.call<string>("rename", { from: "first", to: "moved" });
      for (const [tab, label] of [[writer, "the writer"], [reader, "the reader"]] as const) {
        await until(
          () => titles(tab),
          (rows) => rows.includes("moved"),
          `${label} to render the optimistic layer`,
        );
      }

      const receiver = replicaDatabaseScopeOf(identity);
      const queued = await leader.outbox().restore(replicaScopeOf(identity));
      await leader.outbox().acknowledge(queued.records[0]!, {
        _tag: "Committed",
        settled: 1,
        output: {},
        mappings: [],
      });

      const installed = await leader.applyChange(changeFrame({
        type: "Change",
        protocol: 4,
        identity,
        from: REVISION,
        revision: NEXT_REVISION,
        ordinal: 2,
        settled: 1,
        datoms: [
          ...renamed(NOTES[0]!.entity, "first", "server-decided"),
          ...noteDatoms([{ entity: opaque("g"), title: "third", rank: "c" }]),
        ],
      }));
      installed?.release();
      for (const [tab, label] of [[writer, "the writer"], [reader, "the reader"]] as const) {
        expect(
          await until(
            () => titles(tab),
            (rows) => rows.includes("third"),
            `${label} to adopt the committed change`,
          ),
        ).toEqual(["moved", "second", "third"]);
      }

      const activation = await leader.outbox().beginActivation(receiver);
      await leader.outbox().fenceActivation(receiver, activation);

      for (const [tab, label] of [[writer, "the writer"], [reader, "the reader"]] as const) {
        expect(
          await until(
            () => titles(tab),
            (rows) => rows.includes("server-decided"),
            `${label} to render the authoritative outcome`,
          ),
        ).toEqual(["server-decided", "second", "third"]);
      }
    } finally {
      leader.close();
      await reader.close();
      await writer.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "a fence after the committed basis moved past a queued layer retires it at once",
  async ({ browser }) => {
    const name = `ramose-propagation-fence-advanced-${browser.uniqueId}`;
    const database = databaseOf(browser.uniqueId);
    const identity = await identityFor(database);
    await seed(name, identity, NOTES);
    const writer = await openTab(tabModule);
    const reader = await openTab(tabModule);
    const leader = await IndexedDbReplicaStorage.open(name);
    try {
      await started(writer, name, database);
      await started(reader, name, database);

      await writer.call<string>("rename", { from: "first", to: "moved" });
      for (const [tab, label] of [[writer, "the writer"], [reader, "the reader"]] as const) {
        await until(
          () => titles(tab),
          (rows) => rows.includes("moved"),
          `${label} to render the optimistic layer`,
        );
      }

      const installed = await leader.applyChange(changeFrame({
        type: "Change",
        protocol: 4,
        identity,
        from: REVISION,
        revision: NEXT_REVISION,
        ordinal: 2,
        settled: 1,
        datoms: [
          ...renamed(NOTES[0]!.entity, "first", "server-decided"),
          ...noteDatoms([{ entity: opaque("g"), title: "third", rank: "c" }]),
        ],
      }));
      installed?.release();
      for (const [tab, label] of [[writer, "the writer"], [reader, "the reader"]] as const) {
        expect(
          await until(
            () => titles(tab),
            (rows) => rows.includes("third"),
            `${label} to adopt the committed change`,
          ),
        ).toEqual(["moved", "second", "third"]);
      }

      const receiver = replicaDatabaseScopeOf(identity);
      const queued = await leader.outbox().restore(replicaScopeOf(identity));
      await leader.outbox().acknowledge(queued.records[0]!, {
        _tag: "Committed",
        settled: 1,
        output: {},
        mappings: [],
      });
      const activation = await leader.outbox().beginActivation(receiver);
      await leader.outbox().fenceActivation(receiver, activation);

      for (const [tab, label] of [[writer, "the writer"], [reader, "the reader"]] as const) {
        expect(
          await until(
            () => titles(tab),
            (rows) => rows.includes("server-decided"),
            `${label} to render the authoritative outcome`,
          ),
        ).toEqual(["server-decided", "second", "third"]);
      }
    } finally {
      leader.close();
      await reader.close();
      await writer.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "a tab that never saw the layer queued renders the committed outcome at the fence",
  async ({ browser }) => {
    const name = `ramose-propagation-fence-unseen-${browser.uniqueId}`;
    const database = databaseOf(browser.uniqueId);
    const identity = await identityFor(database);
    await seed(name, identity, NOTES);
    const writer = await openTab(tabModule);
    const leader = await IndexedDbReplicaStorage.open(name);
    let reader: TabHandle | undefined;
    try {
      await started(writer, name, database);
      await writer.call<string>("rename", { from: "first", to: "moved" });
      await until(
        () => titles(writer),
        (rows) => rows.includes("moved"),
        "the writer to render the optimistic layer",
      );

      const receiver = replicaDatabaseScopeOf(identity);
      const queued = await leader.outbox().restore(replicaScopeOf(identity));
      await leader.outbox().acknowledge(queued.records[0]!, {
        _tag: "Committed",
        settled: 1,
        output: {},
        mappings: [],
      });
      const installed = await leader.applyChange(changeFrame({
        type: "Change",
        protocol: 4,
        identity,
        from: REVISION,
        revision: NEXT_REVISION,
        ordinal: 2,
        settled: 1,
        datoms: [
          ...renamed(NOTES[0]!.entity, "first", "server-decided"),
          ...noteDatoms([{ entity: opaque("g"), title: "third", rank: "c" }]),
        ],
      }));
      installed?.release();

      reader = await openTab(tabModule);
      expect(await started(reader, name, database)).toBeDefined();
      expect(
        await until(
          () => titles(reader!),
          (rows) => rows.includes("third"),
          "the fresh tab to compose the retained layer",
        ),
      ).toEqual(["moved", "second", "third"]);

      const activation = await leader.outbox().beginActivation(receiver);
      await leader.outbox().fenceActivation(receiver, activation);

      expect(
        await until(
          () => titles(reader!),
          (rows) => rows.includes("server-decided"),
          "the fresh tab to render the authoritative outcome",
        ),
      ).toEqual(["server-decided", "second", "third"]);
    } finally {
      leader.close();
      await reader?.close();
      await writer.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "a layer seen queued and then absent is carried until its settlement is covered",
  async ({ browser }) => {
    const name = `ramose-propagation-fence-coalesced-${browser.uniqueId}`;
    const database = databaseOf(browser.uniqueId);
    const identity = await identityFor(database);
    await seed(name, identity, NOTES);
    const writer = await openTab(tabModule);
    const reader = await openTab(tabModule);
    const leader = await IndexedDbReplicaStorage.open(name);
    try {
      expect(await reader.call<boolean>("withoutBroadcasts")).toBe(true);
      await started(writer, name, database);
      await started(reader, name, database);

      await writer.call<string>("rename", { from: "first", to: "moved" });
      reader.wake();
      expect(
        await until(
          () => titles(reader),
          (rows) => rows.includes("moved"),
          "the unnotified reader to observe the layer queued",
        ),
      ).toEqual(["moved", "second"]);

      const receiver = replicaDatabaseScopeOf(identity);
      const queued = await leader.outbox().restore(replicaScopeOf(identity));
      await leader.outbox().acknowledge(queued.records[0]!, {
        _tag: "Committed",
        settled: 1,
        output: {},
        mappings: [],
      });
      const activation = await leader.outbox().beginActivation(receiver);
      await leader.outbox().fenceActivation(receiver, activation);

      reader.wake();
      await steady(
        () => titles(reader),
        (rows) => rows.length === 0 || rows.includes("moved"),
        "the reader's position across a coalesced acknowledgement and fence",
        25,
      );
      await monotone(reader, "the reader", ["first"], "moved");

      const installed = await leader.applyChange(changeFrame({
        type: "Change",
        protocol: 4,
        identity,
        from: REVISION,
        revision: NEXT_REVISION,
        ordinal: 2,
        settled: 1,
        datoms: [
          ...renamed(NOTES[0]!.entity, "first", "server-decided"),
          ...noteDatoms([{ entity: opaque("g"), title: "third", rank: "c" }]),
        ],
      }));
      installed?.release();
      reader.wake();

      expect(
        await until(
          () => titles(reader),
          (rows) => rows.includes("server-decided"),
          "the reader to retire the carried layer once its settlement is covered",
        ),
      ).toEqual(["server-decided", "second", "third"]);
      await monotone(reader, "the reader", ["first"], "moved");
    } finally {
      leader.close();
      await reader.close();
      await writer.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "an unrelated committed change between the queue and the fence keeps the layer",
  async ({ browser }) => {
    const name = `ramose-propagation-fence-unrelated-${browser.uniqueId}`;
    const database = databaseOf(browser.uniqueId);
    const identity = await identityFor(database);
    await seed(name, identity, NOTES);
    const writer = await openTab(tabModule);
    const reader = await openTab(tabModule);
    const leader = await IndexedDbReplicaStorage.open(name);
    const tabs = [[writer, "the writer"], [reader, "the reader"]] as const;
    try {
      await started(writer, name, database);
      await started(reader, name, database);

      await writer.call<string>("rename", { from: "first", to: "moved" });
      for (const [tab, label] of tabs) {
        await until(
          () => titles(tab),
          (rows) => rows.includes("moved"),
          `${label} to render the optimistic layer`,
        );
      }

      const unrelated = await leader.applyChange(changeFrame({
        type: "Change",
        protocol: 4,
        identity,
        from: REVISION,
        revision: NEXT_REVISION,
        ordinal: 2,
        settled: 0,
        datoms: noteDatoms([{ entity: opaque("g"), title: "third", rank: "c" }]),
      }));
      unrelated?.release();
      for (const [tab, label] of tabs) {
        expect(
          await until(
            () => titles(tab),
            (rows) => rows.includes("third"),
            `${label} to adopt the unrelated committed change`,
          ),
        ).toEqual(["moved", "second", "third"]);
      }

      const receiver = replicaDatabaseScopeOf(identity);
      const queued = await leader.outbox().restore(replicaScopeOf(identity));
      await leader.outbox().acknowledge(queued.records[0]!, {
        _tag: "Committed",
        settled: 1,
        output: {},
        mappings: [],
      });
      const activation = await leader.outbox().beginActivation(receiver);
      await leader.outbox().fenceActivation(receiver, activation);

      await steady(
        async () => ({
          writer: await titles(writer),
          reader: await titles(reader),
        }),
        (rendered) =>
          [rendered.writer, rendered.reader].every((rows) =>
            rows.length === 0 || rows.includes("moved")
          ),
        "the rendered position after an unrelated change moved the basis",
        25,
      );
      for (const [tab, label] of tabs) await monotone(tab, label, ["first"], "moved");

      const covering = await leader.applyChange(changeFrame({
        type: "Change",
        protocol: 4,
        identity,
        from: NEXT_REVISION,
        revision: THIRD_REVISION,
        ordinal: 3,
        settled: 1,
        datoms: renamed(NOTES[0]!.entity, "first", "server-decided"),
      }));
      covering?.release();

      for (const [tab, label] of tabs) {
        expect(
          await until(
            () => titles(tab),
            (rows) => rows.includes("server-decided"),
            `${label} to retire the layer its settlement now covers`,
          ),
        ).toEqual(["server-decided", "second", "third"]);
        await monotone(tab, label, ["first"], "moved");
      }
    } finally {
      leader.close();
      await reader.close();
      await writer.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "a tab that never saw the layer queued carries it until its settlement is covered",
  async ({ browser }) => {
    const name = `ramose-propagation-fence-carried-${browser.uniqueId}`;
    const database = databaseOf(browser.uniqueId);
    const identity = await identityFor(database);
    await seed(name, identity, NOTES);
    const writer = await openTab(tabModule);
    const leader = await IndexedDbReplicaStorage.open(name);
    let reader: TabHandle | undefined;
    try {
      await started(writer, name, database);
      await writer.call<string>("rename", { from: "first", to: "moved" });
      await until(
        () => titles(writer),
        (rows) => rows.includes("moved"),
        "the writer to render the optimistic layer",
      );

      const receiver = replicaDatabaseScopeOf(identity);
      const queued = await leader.outbox().restore(replicaScopeOf(identity));
      await leader.outbox().acknowledge(queued.records[0]!, {
        _tag: "Committed",
        settled: 1,
        output: {},
        mappings: [],
      });

      reader = await openTab(tabModule);
      expect((await started(reader, name, database)).titles)
        .toEqual(["moved", "second"]);

      const activation = await leader.outbox().beginActivation(receiver);
      await leader.outbox().fenceActivation(receiver, activation);

      await steady(
        () => titles(reader!),
        (rows) => rows.length === 0 || rows.includes("moved"),
        "the fresh tab's position after the fence",
        25,
      );
      await monotone(reader, "the fresh tab", ["first"], "moved");

      const installed = await leader.applyChange(changeFrame({
        type: "Change",
        protocol: 4,
        identity,
        from: REVISION,
        revision: NEXT_REVISION,
        ordinal: 2,
        settled: 1,
        datoms: [
          ...renamed(NOTES[0]!.entity, "first", "server-decided"),
          ...noteDatoms([{ entity: opaque("g"), title: "third", rank: "c" }]),
        ],
      }));
      installed?.release();

      expect(
        await until(
          () => titles(reader!),
          (rows) => rows.includes("server-decided"),
          "the fresh tab to retire the carried layer once its settlement is covered",
        ),
      ).toEqual(["server-decided", "second", "third"]);
      await monotone(reader, "the fresh tab", ["first"], "moved");
    } finally {
      leader.close();
      await reader?.close();
      await writer.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "later activations over a carried layer never return a tab to the position it left",
  async ({ browser }) => {
    const name = `ramose-propagation-fence-repeated-${browser.uniqueId}`;
    const database = databaseOf(browser.uniqueId);
    const identity = await identityFor(database);
    await seed(name, identity, NOTES);
    const writer = await openTab(tabModule);
    const reader = await openTab(tabModule);
    const leader = await IndexedDbReplicaStorage.open(name);
    const tabs = [[writer, "the writer"], [reader, "the reader"]] as const;
    try {
      await started(writer, name, database);
      await started(reader, name, database);

      await writer.call<string>("rename", { from: "first", to: "moved" });
      for (const [tab, label] of tabs) {
        await until(
          () => titles(tab),
          (rows) => rows.includes("moved"),
          `${label} to render the optimistic layer`,
        );
      }

      const receiver = replicaDatabaseScopeOf(identity);
      const queued = await leader.outbox().restore(replicaScopeOf(identity));
      await leader.outbox().acknowledge(queued.records[0]!, {
        _tag: "Committed",
        settled: 1,
        output: {},
        mappings: [],
      });

      for (let pass = 0; pass < 3; pass++) {
        const activation = await leader.outbox().beginActivation(receiver);
        await leader.outbox().fenceActivation(receiver, activation);
        await steady(
          async () => ({
            writer: await titles(writer),
            reader: await titles(reader),
          }),
          (rendered) =>
            [rendered.writer, rendered.reader].every((rows) =>
              rows.length === 0 || rows.includes("moved")
            ),
          `the rendered position after activation ${pass}`,
          10,
        );
      }
      for (const [tab, label] of tabs) await monotone(tab, label, ["first"], "moved");

      const installed = await leader.applyChange(changeFrame({
        type: "Change",
        protocol: 4,
        identity,
        from: REVISION,
        revision: NEXT_REVISION,
        ordinal: 2,
        settled: 1,
        datoms: [
          ...renamed(NOTES[0]!.entity, "first", "server-decided"),
          ...noteDatoms([{ entity: opaque("g"), title: "third", rank: "c" }]),
        ],
      }));
      installed?.release();

      for (const [tab, label] of tabs) {
        expect(
          await until(
            () => titles(tab),
            (rows) => rows.includes("server-decided"),
            `${label} to render the authoritative outcome`,
          ),
        ).toEqual(["server-decided", "second", "third"]);
        await monotone(tab, label, ["first"], "moved");
      }
    } finally {
      leader.close();
      await reader.close();
      await writer.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "a settlement that changes nothing visible still retires the carried layer",
  async ({ browser }) => {
    const name = `ramose-propagation-settlement-only-${browser.uniqueId}`;
    const database = databaseOf(browser.uniqueId);
    const identity = await identityFor(database);
    await seed(name, identity, NOTES);
    const writer = await openTab(tabModule);
    const reader = await openTab(tabModule);
    const leader = await IndexedDbReplicaStorage.open(name);
    const tabs = [[writer, "the writer"], [reader, "the reader"]] as const;
    try {
      await started(writer, name, database);
      await started(reader, name, database);

      await writer.call<string>("rename", { from: "first", to: "moved" });
      for (const [tab, label] of tabs) {
        await until(
          () => titles(tab),
          (rows) => rows.includes("moved"),
          `${label} to render the optimistic layer`,
        );
      }

      const receiver = replicaDatabaseScopeOf(identity);
      const queued = await leader.outbox().restore(replicaScopeOf(identity));
      await leader.outbox().acknowledge(queued.records[0]!, {
        _tag: "Committed",
        settled: 1,
        output: {},
        mappings: [],
      });
      const activation = await leader.outbox().beginActivation(receiver);
      await leader.outbox().fenceActivation(receiver, activation);

      for (const [tab] of tabs) tab.wake();
      await steady(
        async () => ({
          writer: await titles(writer),
          reader: await titles(reader),
        }),
        (rendered) =>
          [rendered.writer, rendered.reader].every((rows) =>
            rows.length === 0 || rows.includes("moved")
          ),
        "the carried layer before its settlement is covered",
        15,
      );

      expect(await leader.acknowledgeOrdinal({
        identity,
        revision: REVISION,
        ordinal: 1,
        settled: 1,
      })).toEqual({ ordinal: 1, settled: 1 });

      for (const [tab, label] of tabs) {
        tab.wake();
        expect(
          await until(
            () => titles(tab),
            (rows) => !rows.includes("moved"),
            `${label} to retire the layer the settlement now covers`,
          ),
        ).toEqual(["first", "second"]);
      }
    } finally {
      leader.close();
      await reader.close();
      await writer.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "a layer acknowledged before settlements existed is carried, never snapped back",
  async ({ browser }) => {
    const name = `ramose-propagation-legacy-layer-${browser.uniqueId}`;
    const database = databaseOf(browser.uniqueId);
    const identity = await identityFor(database);
    await seed(name, identity, NOTES);
    const writer = await openTab(tabModule);
    const reader = await openTab(tabModule);
    const leader = await IndexedDbReplicaStorage.open(name);
    const tabs = [[writer, "the writer"], [reader, "the reader"]] as const;
    try {
      await started(writer, name, database);
      await started(reader, name, database);

      await writer.call<string>("rename", { from: "first", to: "moved" });
      for (const [tab, label] of tabs) {
        await until(
          () => titles(tab),
          (rows) => rows.includes("moved"),
          `${label} to render the optimistic layer`,
        );
      }

      const receiver = replicaDatabaseScopeOf(identity);
      const queued = await leader.outbox().restore(replicaScopeOf(identity));
      await leader.outbox().acknowledge(queued.records[0]!, {
        _tag: "Committed",
        settled: 1,
        output: {},
        mappings: [],
      });

      expect(await stripSettlements(name)).toBeGreaterThan(0);
      for (const [tab] of tabs) tab.wake();
      for (const [tab, label] of tabs) {
        await until(
          () => titles(tab),
          (rows) => rows.includes("moved"),
          `${label} to render the settlement-pending layer`,
        );
      }

      const invocation = queued.records[0]!.invocation;
      const requeued = await until(
        async () => (await leader.outbox().restore(replicaScopeOf(identity))).records,
        (records) => records.length === 1,
        "a reconciler pass to re-enqueue the settlement-pending invocation",
      );
      expect(requeued[0]!.invocation).toBe(invocation);
      expect(requeued[0]!.input).toEqual(queued.records[0]!.input);
      expect(await leader.outbox().recoverPendingSettlements(receiver)).toEqual([]);

      const activation = await leader.outbox().beginActivation(receiver);
      await leader.outbox().fenceActivation(receiver, activation);
      for (const [tab] of tabs) tab.wake();

      await steady(
        async () => ({
          writer: await titles(writer),
          reader: await titles(reader),
        }),
        (rendered) =>
          [rendered.writer, rendered.reader].every((rows) =>
            rows.length === 0 || rows.includes("moved")
          ),
        "the settlement-pending layer across the fence",
        25,
      );
      for (const [tab, label] of tabs) await monotone(tab, label, ["first"], "moved");

      const replaying = await leader.outbox().restore(replicaScopeOf(identity));
      expect(replaying.records.map((record) => record.invocation)).toEqual([invocation]);
      expect((await leader.outbox().acknowledge(replaying.records[0]!, {
        _tag: "Committed",
        settled: 1,
        output: {},
        mappings: [],
      })).settled).toBe(1);
      expect((await leader.outbox().observationState(receiver)).settlements)
        .toEqual(new Map([[invocation, 1]]));

      for (const [tab] of tabs) tab.wake();
      await steady(
        async () => ({
          writer: await titles(writer),
          reader: await titles(reader),
        }),
        (rendered) =>
          [rendered.writer, rendered.reader].every((rows) =>
            rows.length === 0 || rows.includes("moved")
          ),
        "the recovered layer before its settlement is covered",
        15,
      );

      const installed = await leader.applyChange(changeFrame({
        type: "Change",
        protocol: 4,
        identity,
        from: REVISION,
        revision: NEXT_REVISION,
        ordinal: 2,
        settled: 1,
        datoms: [
          ...renamed(NOTES[0]!.entity, "first", "server-decided"),
          ...noteDatoms([{ entity: opaque("g"), title: "third", rank: "c" }]),
        ],
      }));
      installed?.release();

      for (const [tab, label] of tabs) {
        expect(
          await until(
            () => titles(tab),
            (rows) => rows.includes("server-decided"),
            `${label} to retire the recovered layer on coverage`,
          ),
        ).toEqual(["server-decided", "second", "third"]);
        await monotone(tab, label, ["first"], "moved");
      }
    } finally {
      leader.close();
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
        { _tag: "Committed", settled: 1, output: {}, mappings: [] },
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
