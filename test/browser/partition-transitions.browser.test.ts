import { expect } from "vitest";
import { replicaLeaderKey } from "../../packages/ramose/src/internal/replication/leadership.ts";
import { replicaDatabaseScopeOf } from "../../packages/ramose/src/internal/replication/replica-lifecycle.ts";
import { createClient } from "../../packages/ramose/src/client/index.ts";
import { installClientCatalog } from "../../packages/ramose/src/client/catalog.ts";
import { ClientDatabaseHandle } from "../../packages/ramose/src/client/database.ts";
import { GraphRegistry } from "../../packages/ramose/src/client/graph.ts";
import { IndexedDbReplicaStorage } from "../../packages/ramose/src/internal/replication/indexeddb.ts";
import { browserTest } from "./fixtures.ts";
import { openTab, type TabHandle } from "./tab-harness.ts";
import {
  CACHE_KEY,
  CHILD_LINEAGE,
  CHILD_PATH,
  identityFor,
  Note,
  NotesCatalog,
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

/** Whether some other browsing context is holding this scope's leadership. */
const lockHeld = async (key: string): Promise<boolean> => {
  let granted = false;
  await navigator.locks.request(key, { ifAvailable: true }, (lock) => {
    granted = lock !== null;
  });
  return !granted;
};

const leaderKey = async (
  storageName: string,
  database: string,
  principal?: string,
): Promise<string> =>
  replicaLeaderKey(
    replicaDatabaseScopeOf(await identityFor(database, [], principal)),
    storageName,
  );

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
      const leadership = await leaderKey(name, database);
      expect(await lockHeld(leadership)).toBe(true);

      // The second holder is activating: it has read the barrier and has no
      // authenticated identity yet, so it is not enrolled in the scope at all.
      expect(await activating.call<number>("admit", { storageName: name })).toBe(0);

      expect(await clearing.call<string>("clearLocal")).toBe("closed");

      // Clearing awaits the shutdown it started, so the leadership this tab
      // held is given up by the time the call returns.
      expect(await lockHeld(leadership)).toBe(false);

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
    const late = await openTab(tabModule);
    try {
      expect((await started(reader, name, database)).titles)
        .toEqual(["first", "second"]);

      // A third tab is authenticating as the principal about to be replaced,
      // and will not answer until after the replacement has landed.
      expect(await late.call<number>("admit", { storageName: name })).toBe(0);

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

      // A confirmation that names another scope elects for that one and gives
      // the leadership of the scope before it back.
      const successorLeadership = await leaderKey(name, database, REPLACEMENT);
      await until(
        () => lockHeld(successorLeadership),
        (held) => held,
        "the reading tab to stand for the replacement principal",
      );
      expect(await lockHeld(await leaderKey(name, database))).toBe(false);

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

      // The activation that was still authenticating as the replaced
      // principal cannot put the account back to it either.
      expect(await late.call<string>("bindHeld", {
        storageName: name,
        database,
      })).toBe("ReplicaFencedError");
      const candidates = await dumpStore(name, "replica-cache-candidates-v1") as
        readonly { readonly identity: { readonly principal: string } }[];
      expect(candidates.map((candidate) => candidate.identity.principal))
        .toEqual([REPLACEMENT]);
    } finally {
      await late.close();
      await reader.close();
      await replacing.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "a refused activation recovers on the wake-up after the application signs in",
  async ({ browser }) => {
    const name = `ramose-partition-signin-${browser.uniqueId}`;
    const database = databaseOf(browser.uniqueId);
    await seed(name, await identityFor(database), NOTES);
    const tab = await openTab(tabModule);
    try {
      await tab.call("signOut");
      await tab.call("start", { storageName: name, database });
      expect(
        await until(
          () => tab.call<string>("sync"),
          (status) => status === "authentication-required",
          "the refused activation",
        ),
      ).toBe("authentication-required");
      expect((await tab.call<QueryReport>("report")).titles).toEqual([]);

      // The application signs in again. The same client instance activates
      // again on its next wake-up and presents the refreshed bearer.
      await tab.call("signIn", { bearer: "bearer-a" });
      tab.wake();

      const settled = await until(
        () => tab.call<QueryReport>("report"),
        (report) => report.titles.length > 0,
        "the client to activate with the refreshed credential",
      );
      expect(settled.titles).toEqual(["first", "second"]);
    } finally {
      await tab.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "a replacement first confirmed on a graph path fences the principal it replaced",
  async ({ browser }) => {
    const name = `ramose-partition-child-replacement-${browser.uniqueId}`;
    const database = databaseOf(browser.uniqueId);
    const child = `c${database}`.slice(0, 43);
    await seed(name, await identityFor(database), NOTES);
    const holder = await openTab(tabModule);
    const replacing = await openTab(tabModule);
    try {
      // A holder writing under the principal about to be replaced.
      const sibling = `x${database}`.slice(0, 43);
      await holder.call("admit", { storageName: name });
      expect(await holder.call<string>("installHeld", {
        storageName: name,
        database: sibling,
        note: { entity: opaque("m"), title: "sibling", rank: "z" },
      })).toBe("landed");

      // The successor is confirmed on a graph path first. Its route slot comes
      // from its own lineage, so the account's records name it nowhere yet.
      await replacing.call("admit", { storageName: name });
      await replacing.call("signIn", { bearer: "bearer-b" });
      expect(await replacing.call<string>("bindHeld", {
        storageName: name,
        database: child,
        principal: REPLACEMENT,
        lineage: [opaque("9")],
      })).toBe("landed");

      // The principal it replaced is fenced all the same.
      expect(await holder.call<string>("installHeld", {
        storageName: name,
        database: sibling,
        note: { entity: opaque("k"), title: "late", rank: "z" },
      })).toBe("ReplicaFencedError");
    } finally {
      await holder.close();
      await replacing.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "a credential the server refuses is presented again once it is refreshed",
  async ({ browser }) => {
    const name = `ramose-partition-refused-${browser.uniqueId}`;
    let bearer = "expired";
    let presented = 0;
    const client = createClient({
      url: globalThis.location.origin,
      root: "refuses-credentials",
      catalog: NotesCatalog,
      auth: () => {
        presented++;
        return { token: bearer, cacheKey: CACHE_KEY };
      },
      storageName: name,
    });
    try {
      const db = client.open();
      const notes = db.observe(db.query.from(Note).orderBy(Note.rank));
      const release = notes.subscribe(() => undefined);
      try {
        await until(
          () => Promise.resolve(client.sync.getSnapshot().status),
          (status) => status === "authentication-required",
          "the server to refuse the credential",
        );
        expect(presented).toBe(1);

        // The application signs in again, and returning to the tab is what
        // presents the refreshed bearer. This client is not terminal.
        bearer = "refreshed";
        globalThis.dispatchEvent(new Event("focus"));

        await until(
          () => Promise.resolve(presented),
          (calls) => calls > 1,
          "the refreshed credential to be presented",
        );
      } finally {
        release();
      }
    } finally {
      await client.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "a wake-up starts one activation for a graph child the server refused",
  async ({ browser }) => {
    const name = `ramose-partition-refused-child-${browser.uniqueId}`;
    const storage = await IndexedDbReplicaStorage.open(name);
    const catalog = await installClientCatalog(NotesCatalog);
    let presented = 0;
    const registry = new GraphRegistry(() => {
      throw new Error("this child resolves no children of its own");
    }, () => undefined);
    const handle = new ClientDatabaseHandle({
      server: globalThis.location.origin,
      root: "refuses-children",
      graphPath: CHILD_PATH,
      graph: () => registry,
      catalog: () => Promise.resolve(catalog),
      storage: () => Promise.resolve(storage),
      credential: () => {
        presented++;
        return Promise.resolve({ token: "bearer-a", cacheKey: CACHE_KEY });
      },
      mutations: {
        databaseOperations: () => new Map(),
        selfOperations: () => new Map(),
        catalog: () => Promise.resolve(catalog),
        storage: () => Promise.resolve(storage),
        assertLive: () => undefined,
        submit: () => undefined,
        applied: () => undefined,
        track: () => undefined,
      },
      assertLive: () => undefined,
      live: () => true,
      onSyncChange: () => undefined,
      onConfirmed: () => undefined,
      onFenced: () => undefined,
    });
    try {
      void handle.activate();
      await until(
        () => Promise.resolve(handle.syncStatus()),
        (status) => status === "authentication-required",
        "the server to refuse the graph child",
      );
      expect(presented).toBe(1);

      // The order a wake-up calls these in: restarting the unconfirmed child
      // is the activation that presents the refreshed credential, and a second
      // one beside it would leave the first holding a session nothing closes.
      for (let wakes = 0; wakes < 3; wakes++) {
        const before = presented;
        handle.reactivateUnconfirmed();
        handle.reactivateRefused();
        expect(presented).toBe(before);
        await until(
          () => Promise.resolve(presented),
          (calls) => calls > before,
          "the child to activate again",
        );
        await steady(
          () => Promise.resolve(presented),
          (calls) => calls === before + 1,
          "the activations one wake-up starts",
        );
        await until(
          () => Promise.resolve(handle.syncStatus()),
          (status) => status === "authentication-required",
          "the server to refuse the child again",
        );
      }
    } finally {
      await handle.close();
      storage.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "a route notice dropped while a child was opening is answered once it settles",
  async ({ browser }) => {
    const name = `ramose-partition-awaited-route-${browser.uniqueId}`;
    const storage = await IndexedDbReplicaStorage.open(name);
    const catalog = await installClientCatalog(NotesCatalog);
    const registry = new GraphRegistry(() => {
      throw new Error("this child resolves no children of its own");
    }, () => undefined);
    const child = (presented: () => void): ClientDatabaseHandle =>
      new ClientDatabaseHandle({
        server: globalThis.location.origin,
        root: "refuses-children",
        graphPath: CHILD_PATH,
        graph: () => registry,
        catalog: () => Promise.resolve(catalog),
        storage: () => Promise.resolve(storage),
        credential: () => {
          presented();
          return Promise.resolve({ token: "bearer-a", cacheKey: CACHE_KEY });
        },
        mutations: {
          databaseOperations: () => new Map(),
          selfOperations: () => new Map(),
          catalog: () => Promise.resolve(catalog),
          storage: () => Promise.resolve(storage),
          assertLive: () => undefined,
          submit: () => undefined,
          applied: () => undefined,
          track: () => undefined,
        },
        assertLive: () => undefined,
        live: () => true,
        onSyncChange: () => undefined,
        onConfirmed: () => undefined,
        onFenced: () => undefined,
      });

    let quiet = 0;
    const undisturbed = child(() => {
      quiet++;
    });
    let woken = 0;
    const notified = child(() => {
      woken++;
    });
    try {
      void notified.activate();
      notified.reactivateUnconfirmed();

      await until(
        () => Promise.resolve(woken),
        (calls) => calls > 1,
        "the dropped notice to be answered",
      );
      await steady(
        () => Promise.resolve(woken),
        (calls) => calls === 2,
        "the activations one dropped notice starts",
      );
      expect(notified.syncStatus()).toBe("authentication-required");

      void undisturbed.activate();
      await until(
        () => Promise.resolve(undisturbed.syncStatus()),
        (status) => status === "authentication-required",
        "the server to refuse the undisturbed child",
      );
      await steady(
        () => Promise.resolve(quiet),
        (calls) => calls === 1,
        "the activations no notice starts",
      );
    } finally {
      await notified.close();
      await undisturbed.close();
      storage.close();
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

      // Work queued for the database about to be evicted.
      await reading.call("enqueue", {
        storageName: name,
        database,
        child,
        title: "queued",
      });

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

      // Eviction frees a cached replica and never the durable work queued for
      // it, so the path a leader reaches that database by outlives the cache.
      expect((await dumpStore(name, "mutation-outbox-v1")).length).toBe(1);
      expect(await evicting.call<readonly string[]>("receiverPath", {
        storageName: name,
        database: child,
      })).toEqual([...CHILD_PATH]);
    } finally {
      await evicting.close();
      await reading.close();
      await deleteDatabase(name);
    }
  },
);
