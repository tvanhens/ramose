import { expect } from "vitest";
import {
  Entity,
  Field,
  Ref,
  Schema,
  string,
} from "../../packages/ramose/src/db/internal.ts";
import {
  createClient,
  type ClientDatabase,
  type Subscription,
} from "../../packages/ramose/src/client/index.ts";
import { installClientCatalog } from "../../packages/ramose/src/client/catalog.ts";
import { IndexedDbReplicaStorage } from "../../packages/ramose/src/internal/replication/indexeddb.ts";
import type {
  ReplicationIdentity,
  SnapshotDatom,
} from "../../packages/ramose/src/internal/replication/protocol.ts";
import { invocationId } from "../../packages/ramose/src/db/refs.ts";
import {
  replicaDatabaseScopeOf,
  replicaScopeOf,
} from "../../packages/ramose/src/internal/replication/replica-lifecycle.ts";
import { rootReplicaRouteSlot } from "../../packages/ramose/src/internal/replication/route-slot.ts";
import {
  replicationActivationAddress,
  replicationCacheSelector,
  replicationCredentialFingerprint,
} from "../../packages/ramose/src/internal/replication/transport.ts";
import recorded from "./frames/optimistic-fence.client.json";
import { browserTest } from "./fixtures.ts";
import { snapshotChunk } from "../../packages/ramose/test/replication-fixtures.ts";

const Note = Entity("note", {
  title: Field.unique(string(), "strict"),
  rank: string(),
});
const Notes = Schema("client-notes", { note: Note });
Notes.applyPolicy(() => {});

const OFFLINE = "http://127.0.0.1:1";
const ROOT = "app";
const TOKEN = "bearer-a";
const CACHE_KEY = "account-a";

const opaque = (character: string): string => character.repeat(43);

const deleteDatabase = (name: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.addEventListener("success", () => resolve(), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });

const waitFor = <A>(
  subscription: Subscription<A>,
  accept: (value: A) => boolean,
): Promise<A> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stop();
      reject(new Error(`timed out at ${JSON.stringify(subscription.getSnapshot())}`));
    }, 10_000);
    const settle = (): void => {
      const value = subscription.getSnapshot();
      if (!accept(value)) return;
      stop();
      clearTimeout(timer);
      resolve(value);
    };
    const release = subscription.subscribe(settle);
    const stop = (): void => {
      release();
    };
    settle();
  });

type SeededNote = { readonly entity: string; readonly title: string; readonly rank: string };

const seed = async (
  name: string,
  notes: readonly SeededNote[],
  options: { readonly token?: string; readonly cacheKey?: string } = {},
): Promise<ReplicationIdentity> => {
  const installed = await installClientCatalog(Notes);
  const identity: ReplicationIdentity = {
    version: 1,
    server: opaque("s"),
    principal: opaque("p"),
    database: opaque("d"),
    catalog: opaque("c"),
    readView: opaque("v"),
    readCompatibilityHash: installed.readCompatibilityHash,
    authenticator: opaque("a"),
  };
  const datoms: readonly SnapshotDatom[] = notes.flatMap((note) => [
    { entity: note.entity, field: ":ramose/type", value: { type: "string", value: ":note" }, op: "add" },
    { entity: note.entity, field: ":note/title", value: { type: "string", value: note.title }, op: "add" },
    { entity: note.entity, field: ":note/rank", value: { type: "string", value: note.rank }, op: "add" },
  ] as const);
  const storage = await IndexedDbReplicaStorage.open(name);
  try {
    const snapshot = opaque("q");
    const revision = opaque("r");
    await storage.startSnapshot({
      type: "SnapshotStart", protocol: 4, identity, snapshot, revision,
    });
    await storage.stageSnapshotChunk(snapshotChunk({
      type: "SnapshotChunk", protocol: 4, identity, snapshot, index: 0, datoms,
    }));
    const committed = await storage.commitSnapshot({
      type: "SnapshotCommit", protocol: 4, identity, snapshot, revision, ordinal: 1, settled: 0, chunks: 1,
    }, installed.attributes);
    expect(committed).toBeDefined();
    committed!.release();
    const address = replicationActivationAddress({
      server: OFFLINE, root: ROOT,
    });
    const routeSlot = await rootReplicaRouteSlot();
    await storage.bindAuthenticated({
      fingerprint: await replicationCredentialFingerprint(
        options.token ?? TOKEN,
        address,
        routeSlot,
      ),
      identity,
      candidateKey: {
        selector: await replicationCacheSelector(options.cacheKey ?? CACHE_KEY, address),
        routeSlot,
      },
    });
  } finally {
    storage.close();
  }
  return identity;
};

const offlineClient = (name: string, credential = { token: TOKEN, cacheKey: CACHE_KEY }) =>
  createClient({
    url: OFFLINE,
    root: ROOT,
    catalog: Notes,
    auth: () => credential,
    storageName: name,
  });

const titles = (db: ClientDatabase) =>
  db.observe(db.query.from(Note).orderBy(Note.rank).select({ title: Note.title }));

browserTest("renders an exact bearer binding's replica offline and closes deterministically", async ({ browser }) => {
  const name = `ramose-client-exact-${browser.uniqueId}`;
  await seed(name, [
    { entity: opaque("e"), title: "second", rank: "b" },
    { entity: opaque("f"), title: "first", rank: "a" },
  ]);
  const client = offlineClient(name);

  let closed!: ReturnType<typeof titles>;
  try {
    const db = client.open();

    expect(client.sync.getSnapshot().status).toBe("idle");

    const notes = titles(db);
    expect(notes.getSnapshot().status).toBe("pending");

    const held = notes.subscribe(() => undefined);

    const ready = await waitFor(notes, (snapshot) => snapshot.status === "ready");
    expect(ready.data).toEqual([{ title: "first" }, { title: "second" }]);

    expect(ready.stale).toBe(true);

    expect(notes.getSnapshot()).toBe(ready);

    expect(titles(db).getSnapshot()).toBe(ready);

    const offline = await waitFor(client.sync, (state) => state.status === "offline");
    expect(offline.status).toBe("offline");

    expect(notes.getSnapshot().data).toEqual([{ title: "first" }, { title: "second" }]);

    held();
    expect(titles(db).getSnapshot()).toBe(ready);
    closed = notes;
  } finally {
    await client.close();
  }

  expect(client.sync.getSnapshot().status).toBe("closed");
  expect(() => client.open()).toThrow();

  expect(closed.getSnapshot().status).toBe("pending");
  expect(closed.getSnapshot().data).toBeUndefined();

  const storage = await IndexedDbReplicaStorage.open(name);
  try {
    const address = replicationActivationAddress({ server: OFFLINE, root: ROOT });
    const installed = await installClientCatalog(Notes);
    const restored = await storage.restoreBound(
      await replicationCredentialFingerprint(TOKEN, address, await rootReplicaRouteSlot()),
      installed.attributes,
      installed.readCompatibilityHash,
    );
    expect(restored).toBeDefined();
    restored!.release();
  } finally {
    storage.close();
    await deleteDatabase(name);
  }
});

browserTest("retains no observation until something subscribes", async ({ browser }) => {
  const name = `ramose-client-unretained-${browser.uniqueId}`;
  await seed(name, [{ entity: opaque("e"), title: "later", rank: "a" }]);
  const client = offlineClient(name);
  try {
    const db = client.open();

    const notes = titles(db);
    await waitFor(client.sync, (state) => state.status === "offline");
    expect(notes.getSnapshot().status).toBe("pending");

    const held = notes.subscribe(() => undefined);
    expect((await waitFor(notes, (snapshot) => snapshot.status === "ready")).data)
      .toEqual([{ title: "later" }]);
    held();
  } finally {
    await client.close();
    await deleteDatabase(name);
  }
});

browserTest("a withdrawn binding stops selecting the replica it named", async ({ browser }) => {
  const name = `ramose-client-withdrawn-${browser.uniqueId}`;
  await seed(name, [{ entity: opaque("e"), title: "revoked", rank: "a" }]);
  const installed = await installClientCatalog(Notes);
  const fingerprint = await replicationCredentialFingerprint(
    TOKEN,
    replicationActivationAddress({ server: OFFLINE, root: ROOT }),
    await rootReplicaRouteSlot(),
  );

  const storage = await IndexedDbReplicaStorage.open(name);
  try {
    const bound = await storage.restoreBound(
      fingerprint,
      installed.attributes,
      installed.readCompatibilityHash,
    );
    expect(bound).toBeDefined();
    bound!.release();

    await storage.unbindCredential(fingerprint);
    expect(await storage.restoreBound(
      fingerprint,
      installed.attributes,
      installed.readCompatibilityHash,
    )).toBeUndefined();
  } finally {
    storage.close();
  }

  const client = offlineClient(name);
  try {
    const notes = titles(client.open());
    const held = notes.subscribe(() => undefined);
    await waitFor(client.sync, (state) => state.status === "offline");
    expect(notes.getSnapshot().status).toBe("pending");
    held();
  } finally {
    await client.close();
    await deleteDatabase(name);
  }
});

browserTest("reattaches a subscription that is resubscribed after its last listener left", async ({ browser }) => {
  const name = `ramose-client-reattach-${browser.uniqueId}`;
  await seed(name, [{ entity: opaque("e"), title: "kept", rank: "a" }]);
  const client = offlineClient(name);
  try {
    const db = client.open();
    const notes = titles(db);
    const first = notes.subscribe(() => undefined);
    expect((await waitFor(notes, (snapshot) => snapshot.status === "ready")).data)
      .toEqual([{ title: "kept" }]);

    const before = notes.getSnapshot();

    first();

    const seen: string[] = [];
    const second = notes.subscribe(() => seen.push(notes.getSnapshot().status));
    expect(notes.getSnapshot()).toBe(before);
    const reattached = await waitFor(notes, (snapshot) => snapshot.status === "ready");
    expect(reattached.data).toEqual([{ title: "kept" }]);
    expect(seen).not.toContain("pending");

    expect(titles(db).getSnapshot()).toBe(notes.getSnapshot());

    first();
    expect(titles(db).getSnapshot()).toBe(notes.getSnapshot());
    second();
  } finally {
    await client.close();
    await deleteDatabase(name);
  }
});

browserTest("close() drains its continuations before the storage connection closes", async ({ browser }) => {
  const name = `ramose-client-close-drain-${browser.uniqueId}`;
  await seed(name, [{ entity: opaque("e"), title: "kept", rank: "a" }]);
  const closedConnections = new WeakSet<IDBDatabase>();
  const afterClose: string[] = [];
  const realClose = IDBDatabase.prototype.close;
  const realTransaction = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.close = function (this: IDBDatabase): void {
    closedConnections.add(this);
    realClose.call(this);
  };
  IDBDatabase.prototype.transaction = function (
    this: IDBDatabase,
    stores: string | string[],
    mode?: IDBTransactionMode,
    options?: IDBTransactionOptions,
  ): IDBTransaction {
    if (closedConnections.has(this)) {
      afterClose.push(`${this.name}: ${JSON.stringify(stores)}`);
    }
    return realTransaction.call(this, stores, mode, options);
  };
  try {
    for (let round = 0; round < 6; round++) {
      const client = offlineClient(name);
      const notes = titles(client.open());
      const held = notes.subscribe(() => undefined);
      await waitFor(notes, (snapshot) => snapshot.status === "ready");
      held();
      const rerunning = notes.subscribe(() => undefined);
      await client.close();
      rerunning();
    }
    expect(afterClose).toEqual([]);
  } finally {
    IDBDatabase.prototype.close = realClose;
    IDBDatabase.prototype.transaction = realTransaction;
    await deleteDatabase(name);
  }
});

browserTest("reports a oneOrFail miss as an error rather than as rows", async ({ browser }) => {
  const name = `ramose-client-oneorfail-${browser.uniqueId}`;
  await seed(name, [
    { entity: opaque("e"), title: "first", rank: "a" },
    { entity: opaque("f"), title: "second", rank: "b" },
  ]);
  const client = offlineClient(name);
  try {
    const db = client.open();
    const only = db.observe(db.query.from(Note).select({ title: Note.title }).oneOrFail());
    const held = only.subscribe(() => undefined);

    const failed = await waitFor(only, (snapshot) => snapshot.status !== "pending");
    expect(failed.status).toBe("error");
    expect(failed.data).toBeUndefined();
    expect(failed.error?.message).toContain("exactly one row");
    held();
  } finally {
    await client.close();
    await deleteDatabase(name);
  }
});

browserTest("renders nothing offline for a rotated bearer, with or without the cache key", async ({ browser }) => {
  const name = `ramose-client-rotated-${browser.uniqueId}`;
  await seed(name, [{ entity: opaque("e"), title: "hidden", rank: "a" }]);

  for (const credential of [
    { token: "bearer-rotated", cacheKey: CACHE_KEY },
    { token: "bearer-rotated", cacheKey: "another-account" },
  ]) {
    const client = offlineClient(name, credential);
    try {
      const db = client.open();
      const notes = titles(db);
      await waitFor(client.sync, (state) => state.status === "offline");

      expect(notes.getSnapshot().status).toBe("pending");
      expect(notes.getSnapshot().data).toBeUndefined();
    } finally {
      await client.close();
    }
  }
  await deleteDatabase(name);
});

browserTest("activates nothing until a query is observed", async ({ browser }) => {
  const name = `ramose-client-inert-${browser.uniqueId}`;
  const client = offlineClient(name);
  try {
    const db = client.open();

    const query = db.query.from(Note).where({ title: "offline" });
    expect(client.sync.getSnapshot().status).toBe("idle");
    expect((await indexedDB.databases()).some((entry) => entry.name === name)).toBe(false);

    db.observe(query);
    await waitFor(client.sync, (state) => state.status === "offline");
    expect((await indexedDB.databases()).some((entry) => entry.name === name)).toBe(true);
  } finally {
    await client.close();
    await deleteDatabase(name);
  }
});

browserTest("quarantines a layer this build cannot replay, without hiding the committed value", async ({ browser }) => {
  const name = `ramose-client-quarantine-${browser.uniqueId}`;
  const identity = await seed(name, [{ entity: opaque("e"), title: "committed", rank: "a" }]);
  const receiver = replicaDatabaseScopeOf(identity);
  const storage = await IndexedDbReplicaStorage.open(name);
  try {

    await storage.outbox().enqueue({
      invocation: invocationId(),
      receiver,
      operation: {
        catalog: "client-notes" as never,
        owner: { kind: "entity", name: "note" },
        localName: "rename",
      },
      operationVersion: "b".repeat(64) as never,
      target: { type: "none" },
      input: { title: "optimistic" },
      allocations: [],
      inputRefs: [],
      enqueuedAt: 1_700_000_000_000,
    }, {
      scope: replicaScopeOf(identity),
      projection: { revision: 1, build: "another-build" },
    });
  } finally {
    storage.close();
  }

  const client = offlineClient(name);
  try {
    const db = client.open();
    const notes = titles(db);
    const held = notes.subscribe(() => undefined);
    const ready = await waitFor(notes, (snapshot) => snapshot.status === "ready");

    expect(ready.data).toEqual([{ title: "committed" }]);
    expect(await waitFor(client.sync, (state) => state.status === "update-required"))
      .toBeDefined();
    held();
  } finally {
    await client.close();
    await deleteDatabase(name);
  }
});

browserTest("clearLocalData deletes only a confirmed scope and is terminal", async ({ browser }) => {
  const name = `ramose-client-clear-${browser.uniqueId}`;
  await seed(name, [{ entity: opaque("e"), title: "erased", rank: "a" }]);

  const stranger = offlineClient(name, { token: "bearer-stranger", cacheKey: "account-z" });
  await expect(stranger.clearLocalData()).rejects.toMatchObject({
    reason: "no-confirmed-scope",
  });
  await stranger.close();

  const client = offlineClient(name);
  const db = client.open();
  const notes = titles(db);
  await waitFor(notes, (snapshot) => snapshot.status === "ready");

  await client.clearLocalData();
  expect(client.sync.getSnapshot().status).toBe("closed");

  expect(() => client.open()).toThrow();
  await expect(client.clearLocalData()).rejects.toThrow();

  const storage = await IndexedDbReplicaStorage.open(name);
  try {
    const address = replicationActivationAddress({ server: OFFLINE, root: ROOT });
    const installed = await installClientCatalog(Notes);
    expect(await storage.restoreBound(
      await replicationCredentialFingerprint(TOKEN, address, await rootReplicaRouteSlot()),
      installed.attributes,
      installed.readCompatibilityHash,
    )).toBeUndefined();
  } finally {
    storage.close();
    await deleteDatabase(name);
  }
});

browserTest("a clear by one client leaves the other terminal rather than silently dead", async ({ browser }) => {
  const name = `ramose-client-shared-${browser.uniqueId}`;
  await seed(name, [{ entity: opaque("e"), title: "shared", rank: "a" }]);

  const clearing = offlineClient(name);
  const other = offlineClient(name);
  try {
    const watched = titles(other.open());
    const held = watched.subscribe(() => undefined);
    await waitFor(watched, (snapshot) => snapshot.status === "ready");
    const owned = titles(clearing.open());
    await waitFor(owned, (snapshot) => snapshot.status === "ready");

    await clearing.clearLocalData();

    expect((await waitFor(other.sync, (state) => state.status === "closed")).status)
      .toBe("closed");
    expect(() => other.open()).toThrow();
    expect(watched.getSnapshot().data).toBeUndefined();
    held();
  } finally {
    await other.close();
    await clearing.close();
    await deleteDatabase(name);
  }
});

const ConformanceUser = Entity("conformanceUser", {
  sub: Field.unique(string(), "strict"),
  access: string({ default: () => "enabled" }),
});
const ConformanceIssue = Entity("conformanceIssue", {
  key: Field.unique(string(), "strict"),
  title: string(),
  owner: Ref(ConformanceUser),
  org: string(),
  parent: Field(Ref.self, { optional: true }),
  audit: string({ optional: true }),
});
const ConformanceSchema = Schema("local-conformance", {
  conformanceUser: ConformanceUser,
  conformanceIssue: ConformanceIssue,
});
ConformanceSchema.applyPolicy(() => {});

browserTest("derives the read compatibility the recorded Worker authenticated", async () => {
  const installed = await installClientCatalog(ConformanceSchema);
  expect(installed.readCompatibilityHash).toBe(recorded.identity.readCompatibilityHash);
});

browserTest("a committed value enters a query already being observed", async ({ browser }) => {
  const name = `ramose-client-live-${browser.uniqueId}`;
  const client = createClient({
    url: globalThis.location.origin,

    root: "optimistic-fence",
    catalog: ConformanceSchema,
    auth: () => Promise.resolve({ token: "session-credential", cacheKey: "recorded" }),
    storageName: name,
  });
  try {
    const db = client.open();
    const seen: string[] = [];
    client.sync.subscribe(() => seen.push(client.sync.getSnapshot().status));

    const issues = db.observe(
      db.query.from(ConformanceIssue).select({ title: ConformanceIssue.title }),
    );
    expect(issues.getSnapshot().status).toBe("pending");

    const ready = await waitFor(issues, (snapshot) => snapshot.status === "ready");
    expect(ready.data).toBeInstanceOf(Array);
    expect((ready.data as readonly unknown[]).length).toBeGreaterThan(0);

    expect(ready.stale).toBe(false);
    expect(issues.getSnapshot()).toBe(ready);

    expect(seen).toContain("live");
    expect(await waitFor(client.sync, (state) => state.status === "offline")).toBeDefined();
    expect(issues.getSnapshot()).toBe(ready);
  } finally {
    await client.close();
    await deleteDatabase(name);
  }
});

browserTest("fences a replaced principal before any of its data can be read", async ({ browser }) => {
  const name = `ramose-client-transition-${browser.uniqueId}`;
  const installed = await installClientCatalog(ConformanceSchema);

  const prior: ReplicationIdentity = {
    ...(recorded.identity as unknown as ReplicationIdentity),
    principal: opaque("x"),
    authenticator: opaque("y"),
  };
  const entity = opaque("z");
  const storage = await IndexedDbReplicaStorage.open(name);
  try {
    const snapshot = opaque("q");
    const revision = opaque("r");
    await storage.startSnapshot({
      type: "SnapshotStart", protocol: 4, identity: prior, snapshot, revision,
    });
    await storage.stageSnapshotChunk(snapshotChunk({
      type: "SnapshotChunk", protocol: 4, identity: prior, snapshot, index: 0,
      datoms: [
        { entity, field: ":ramose/type", value: { type: "string", value: ":conformanceIssue" }, op: "add" },
        { entity, field: ":conformanceIssue/title", value: { type: "string", value: "prior-principal" }, op: "add" },
      ],
    }));
    (await storage.commitSnapshot({
      type: "SnapshotCommit", protocol: 4, identity: prior, snapshot, revision, ordinal: 1, settled: 0, chunks: 1,
    }, installed.attributes))!.release();
    await storage.bindAuthenticated({
      fingerprint: await replicationCredentialFingerprint(
        "session-credential",
        replicationActivationAddress({
          server: globalThis.location.origin, root: "optimistic-fence",
        }),
        await rootReplicaRouteSlot(),
      ),
      identity: prior,
    });
  } finally {
    storage.close();
  }

  const client = createClient({
    url: globalThis.location.origin,
    root: "optimistic-fence",
    catalog: ConformanceSchema,
    auth: () => ({ token: "session-credential", cacheKey: "recorded" }),
    storageName: name,
  });
  try {
    const db = client.open();
    const statuses: string[] = [];
    client.sync.subscribe(() => statuses.push(client.sync.getSnapshot().status));
    const issues = db.observe(
      db.query.from(ConformanceIssue).select({ title: ConformanceIssue.title }),
    );
    const seen: unknown[] = [];
    issues.subscribe(() => seen.push(issues.getSnapshot().data));

    const settled = await waitFor(
      issues,
      (snapshot) => snapshot.status === "ready" && snapshot.stale === false,
    );
    const shown = settled.data as readonly { readonly title: string }[];

    expect(statuses).toContain("authentication-required");

    expect(shown.some((row) => row.title === "prior-principal")).toBe(false);

    const fenced = seen.slice(seen.lastIndexOf(undefined) + 1);
    expect(fenced.length).toBeGreaterThan(0);
    for (const data of fenced) {
      expect((data as readonly { readonly title: string }[] | undefined)
        ?.some((row) => row.title === "prior-principal") ?? false).toBe(false);
    }
  } finally {
    await client.close();
    await deleteDatabase(name);
  }
});
