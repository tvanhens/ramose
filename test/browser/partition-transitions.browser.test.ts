import { expect } from "vitest";
import { browserTest } from "./fixtures.ts";
import { openTab, type TabHandle } from "./tab-harness.ts";
import {
  CHILD_LINEAGE,
  CHILD_PATH,
  identityFor,
  noteDatoms,
  observeChildRoute,
  opaque,
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

const NOTES = [
  { entity: opaque("e"), title: "first", rank: "a" },
  { entity: opaque("f"), title: "second", rank: "b" },
] as const;

const REPLACEMENT = opaque("2");

const deleteDatabase = (name: string): Promise<void> =>
  new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(name);
    request.addEventListener("success", () => resolve(), { once: true });
    request.addEventListener("error", () => resolve(), { once: true });
    request.addEventListener("blocked", () => resolve(), { once: true });
  });

/** A database id of the shape the protocol uses, unique to one test. */
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

const started = async (
  tab: TabHandle,
  storageName: string,
  database: string,
): Promise<QueryReport> => {
  await tab.call("start", { storageName, database });
  const rendered = await until(
    () => tab.call<QueryReport>("report"),
    (report) => report.status === "ready",
    "the first rendered value",
  );
  await until(
    () => tab.call<string>("sync"),
    (status) => status === "offline",
    "the tab's own stream to end",
  );
  return rendered;
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

browserTest(
  "a clear refuses a holder whose activation began before it and admits its next one",
  async ({ browser }) => {
    const name = `ramose-barrier-inflight-${browser.uniqueId}`;
    const database = databaseOf(browser.uniqueId);
    await seed(name, await identityFor(database), NOTES);
    const clearing = await openTab(tabModule);
    const activating = await openTab(tabModule);
    try {
      expect((await started(clearing, name, database)).titles)
        .toEqual(["first", "second"]);

      // The second holder is activating: it has read the barrier and has no
      // authenticated identity yet, so it is not enrolled in the scope at all.
      expect(await activating.call<number>("admit", { storageName: name })).toBe(0);

      expect(await clearing.call<string>("clearLocal")).toBe("closed");

      // The identity it goes on to authenticate is the one the clear removed,
      // and the install transaction is where that is found out.
      expect(await activating.call<string>("bindHeld", {
        storageName: name,
        database,
      })).toBe("ReplicaFencedError");
      expect(await activating.call<string>("installHeld", {
        storageName: name,
        database,
        note: { entity: opaque("g"), title: "repopulated", rank: "a" },
      })).toBe("ReplicaFencedError");
      expect(await dumpStore(name, "replica-committed-v1")).toEqual([]);
      expect(await dumpStore(name, "replica-credential-bindings-v1")).toEqual([]);

      // Admitted after the clear, the same holder installs a fresh replica:
      // the barrier refused the activation the clear overtook, not the scope.
      expect(await activating.call<number>("admit", { storageName: name })).toBe(1);
      expect(await activating.call<string>("bindHeld", {
        storageName: name,
        database,
      })).toBe("landed");
      expect(await activating.call<string>("installHeld", {
        storageName: name,
        database,
        note: { entity: opaque("g"), title: "reinstalled", rank: "a" },
      })).toBe("landed");
      expect((await dumpStore(name, "replica-committed-v1")).length).toBe(1);
    } finally {
      await clearing.close();
      await activating.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "a clear in one tab withdraws the value another tab is rendering",
  async ({ browser }) => {
    const name = `ramose-barrier-withdraw-${browser.uniqueId}`;
    const database = databaseOf(browser.uniqueId);
    await seed(name, await identityFor(database), NOTES);
    const clearing = await openTab(tabModule);
    const reader = await openTab(tabModule);
    try {
      expect((await started(clearing, name, database)).titles)
        .toEqual(["first", "second"]);
      expect((await started(reader, name, database)).titles)
        .toEqual(["first", "second"]);

      await clearing.call<string>("clearLocal");

      await until(
        () => reader.call<QueryReport>("report"),
        (report) => report.titles.length === 0,
        "the reading tab to withdraw the cleared value",
      );
      await steady(
        () => reader.call<QueryReport>("report"),
        (report) => report.titles.length === 0,
        "the withdrawn value",
      );

      // Nothing the cleared scope held was published again on the way here.
      const published = await reader.call<readonly QueryReport[]>("published");
      const held = published.map((report) => report.titles.length > 0);
      expect(held).toContain(true);
      expect(held.lastIndexOf(true)).toBeLessThan(held.length - 1);
      for (const report of published.slice(held.lastIndexOf(true) + 1)) {
        expect(report.titles).toEqual([]);
      }
    } finally {
      await clearing.close();
      await reader.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "a principal replacement in one tab fences the tab still holding the one before it",
  async ({ browser }) => {
    const name = `ramose-barrier-principal-${browser.uniqueId}`;
    const database = databaseOf(browser.uniqueId);
    const replaced = await identityFor(database);
    const replacement = await identityFor(database, [], REPLACEMENT);
    await seed(name, replaced, NOTES);
    await seedDatabases(name, [{
      identity: replacement,
      datoms: noteDatoms([{ entity: opaque("n"), title: "successor", rank: "a" }]),
      bind: false,
    }]);
    const reader = await openTab(tabModule);
    const replacing = await openTab(tabModule);
    try {
      expect((await started(reader, name, database)).titles)
        .toEqual(["first", "second"]);

      // A holder of the principal about to be replaced, writing under it.
      const sibling = `x${database}`.slice(0, 43);
      await replacing.call("admit", { storageName: name });
      expect(await replacing.call<string>("installHeld", {
        storageName: name,
        database: sibling,
        note: { entity: opaque("m"), title: "sibling", rank: "z" },
      })).toBe("landed");

      // The application signs the reading tab in as the account's new
      // principal, and the other tab is the one whose session confirms it.
      await reader.call("signIn", { bearer: "bearer-b" });
      await replacing.call("signIn", { bearer: "bearer-b" });
      expect(await replacing.call<string>("bindHeld", {
        storageName: name,
        database,
        principal: REPLACEMENT,
      })).toBe("landed");

      const settled = await until(
        () => reader.call<QueryReport>("report"),
        (report) => report.titles.length > 0 && report.titles[0] !== "first",
        "the reading tab to rebind to the replacement principal",
      );
      expect(settled.titles).toEqual(["successor"]);

      const published = await reader.call<readonly QueryReport[]>("published");
      const rebound = published.findIndex(
        (report) => report.titles.includes("successor"),
      );
      expect(rebound).toBeGreaterThan(0);
      for (const report of published.slice(rebound)) {
        expect(report.titles).not.toContain("first");
        expect(report.titles).not.toContain("second");
      }

      // A holder writing under the replaced principal is refused the moment
      // the replacement lands, whether or not the notice ever arrived.
      expect(await replacing.call<string>("installHeld", {
        storageName: name,
        database: sibling,
        note: { entity: opaque("m"), title: "late", rank: "z" },
      })).toBe("ReplicaFencedError");
    } finally {
      await reader.close();
      await replacing.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "a read view another tab rotated is what a durable re-read publishes",
  async ({ browser }) => {
    const name = `ramose-partition-rotation-${browser.uniqueId}`;
    const database = databaseOf(browser.uniqueId);
    const held = await identityFor(database);
    const rotated = { ...held, readView: opaque("w") };
    await seed(name, held, NOTES);
    const reader = await openTab(tabModule);
    try {
      expect((await started(reader, name, database)).titles)
        .toEqual(["first", "second"]);

      // Another holder installs the rotated read view of the same database
      // and binds this bearer to it, which is what a confirming tab does.
      await seedDatabases(name, [{
        identity: rotated,
        datoms: noteDatoms([{ entity: opaque("r"), title: "rotated", rank: "a" }]),
      }]);
      reader.wake();

      const settled = await until(
        () => reader.call<QueryReport>("report"),
        (report) => report.titles.includes("rotated"),
        "the reading tab to publish the rotated read view",
      );
      expect(settled.titles).toEqual(["rotated"]);

      const published = await reader.call<readonly QueryReport[]>("published");
      const rebound = published.findIndex(
        (report) => report.titles.includes("rotated"),
      );
      for (const report of published.slice(rebound)) {
        expect(report.titles).not.toContain("first");
      }
    } finally {
      await reader.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "an eviction in one tab never leaves another tab a partial database",
  async ({ browser }) => {
    const name = `ramose-barrier-eviction-${browser.uniqueId}`;
    const database = databaseOf(browser.uniqueId);
    const child = `c${database}`.slice(0, 43);
    const childIdentity = await identityFor(child, CHILD_LINEAGE);
    await seedDatabases(name, [
      {
        identity: await identityFor(database),
        datoms: [...noteDatoms(NOTES), ...workspaceDatoms(CHILD_LINEAGE[0]!)],
      },
      {
        identity: childIdentity,
        datoms: noteDatoms([
          { entity: opaque("g"), title: "child-one", rank: "a" },
          { entity: opaque("h"), title: "child-two", rank: "b" },
        ]),
        graphPath: CHILD_PATH,
        observeRoute: true,
      },
    ]);
    await observeChildRoute(name, childIdentity);
    const evicting = await openTab(tabModule);
    const reading = await openTab(tabModule);
    try {
      const restoring = {
        storageName: name,
        database: child,
        lineage: CHILD_LINEAGE,
      };
      expect(await reading.call<number>("restoreOnce", restoring)).toBe(2);

      const probing = reading.call<readonly number[]>("probeRestores", restoring);
      expect(await evicting.call<string>("evict", {
        storageName: name,
        database: child,
      })).toBe("landed");

      // Every restore that found the database found all of it: the eviction
      // deletes a database as one unit, so a reader sees it whole or not.
      for (const found of await probing) expect(found).toBe(2);
      expect(await reading.call<number>("restoreOnce", restoring)).toBe(-1);
      expect(await evicting.call<number>("restoreOnce", restoring)).toBe(-1);
    } finally {
      await evicting.close();
      await reading.close();
      await deleteDatabase(name);
    }
  },
);
