/**
 * The public client, end to end in a real browser (#477 slice 1).
 *
 * Nothing here is simulated. Real Chromium IndexedDB with its real transaction
 * semantics, the real replica installer, the real credential binding and cache
 * selector over WebCrypto, the real `ReplicationSession`, the real query
 * engine — reached only through `createClient`, exactly as an application does.
 *
 * Two lanes:
 *
 * 1. **Offline.** A replica installed and bound in a previous "session", then
 *    read back through the public API against an origin that refuses every
 *    connection. That is the whole offline contract: an exact bearer binding
 *    renders its compatible replica stale, and a rotated one renders nothing.
 * 2. **Live.** One activation against the *recorded* real-Worker frame fixture
 *    (`test/browser/frames/PROVENANCE.md`), served as inert bytes over the real
 *    HTTP path, so the committed value arrives through the real session and
 *    enters a query that was already being observed.
 */

import { expect } from "vitest";
import { compileReadAuthorization } from "../../packages/ramose/src/internal/authorization/index.ts";
import { Catalog } from "../../packages/ramose/src/Catalog.ts";
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

// ── the application's catalog ───────────────────────────────────────────────

const Note = Entity("note", {
  title: Field.unique(string(), "strict"),
  rank: string(),
});
const Notes = Schema({ note: Note });
/** The policy is never run on a client; it stays the unevaluated authored value. */
const NotesCatalog = Catalog("client-notes", {
  schema: Notes,
  policy: compileReadAuthorization({ schema: Notes, rules: [] }),
});

/** An origin that refuses every connection, so every read has to be local. */
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

/**
 * Install and bind one replica exactly as a prior authenticated session would
 * have left it, then let go of the storage handle.
 */
const seed = async (
  name: string,
  notes: readonly SeededNote[],
  options: { readonly token?: string; readonly cacheKey?: string } = {},
): Promise<ReplicationIdentity> => {
  const installed = await installClientCatalog(NotesCatalog);
  const identity: ReplicationIdentity = {
    version: 1,
    server: opaque("s"),
    principal: opaque("p"),
    database: opaque("d"),
    catalog: opaque("c"),
    readView: opaque("v"),
    readCompatibilityHash: installed.readCompatibilityHash,
    graphLineage: [],
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
      type: "SnapshotStart", protocol: 1, identity, snapshot, revision,
    });
    await storage.stageSnapshotChunk({
      type: "SnapshotChunk", protocol: 1, identity, snapshot, index: 0, datoms,
    });
    const committed = await storage.commitSnapshot({
      type: "SnapshotCommit", protocol: 1, identity, snapshot, revision, chunks: 1,
    }, installed.attributes);
    expect(committed).toBeDefined();
    committed!.release();
    const address = replicationActivationAddress({
      server: OFFLINE, root: ROOT, graphPath: [],
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
    catalog: NotesCatalog,
    auth: () => credential,
    storageName: name,
  });

const titles = (db: ClientDatabase) =>
  db.observe(db.query.from(Note).orderBy(Note.rank).select({ title: Note.title }));

// ── offline lane ───────────────────────────────────────────────────────────

browserTest("renders an exact bearer binding's replica offline and closes deterministically", async ({ browser }) => {
  const name = `ramose-client-exact-${browser.uniqueId}`;
  await seed(name, [
    { entity: opaque("e"), title: "second", rank: "b" },
    { entity: opaque("f"), title: "first", rank: "a" },
  ]);
  const client = offlineClient(name);
  try {
    const db = client.open();
    // Observing is what activates; opening the handle did nothing.
    expect(client.sync.getSnapshot().status).toBe("idle");

    const notes = titles(db);
    expect(notes.getSnapshot().status).toBe("pending");
    // Held for the rest of the test: an observation lives exactly as long as
    // its listeners, so interning is only meaningful while one is attached.
    const held = notes.subscribe(() => undefined);

    const ready = await waitFor(notes, (snapshot) => snapshot.status === "ready");
    expect(ready.data).toEqual([{ title: "first" }, { title: "second" }]);
    // Restored, never confirmed by the current session.
    expect(ready.stale).toBe(true);
    // Stable: reading again returns the very same snapshot object.
    expect(notes.getSnapshot()).toBe(ready);

    // An equal query is one interned observation, and its snapshot is the same.
    expect(titles(db).getSnapshot()).toBe(ready);

    const offline = await waitFor(client.sync, (state) => state.status === "offline");
    expect(offline.status).toBe("offline");
    // The local value stays readable while the server is unreachable.
    expect(notes.getSnapshot().data).toEqual([{ title: "first" }, { title: "second" }]);

    // The last listener releases the observation; a later one starts fresh.
    held();
    expect(titles(db).getSnapshot().status).toBe("pending");
  } finally {
    await client.close();
  }

  expect(client.sync.getSnapshot().status).toBe("closed");
  expect(() => client.open()).toThrow();

  // `close()` released the session, never the durable work: a fresh handle
  // still restores exactly the same committed replica.
  const storage = await IndexedDbReplicaStorage.open(name);
  try {
    const address = replicationActivationAddress({ server: OFFLINE, root: ROOT, graphPath: [] });
    const installed = await installClientCatalog(NotesCatalog);
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
      // The candidate the cache key nominates is never published: only the
      // current authenticated response could confirm it, and there is none.
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
    // Constructing the client, the handle, and a query value opens no storage.
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
    // A durable layer left by some *other* build: this slice installs no
    // projection, so nothing here can replay it.
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
    // The durable rows are kept and no layer is presented; the committed
    // replica is untouched and still readable.
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

  // A client whose bearer was never bound has no scope it may name, so it
  // deletes nothing and the replica is still there afterwards.
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
  // Terminal: this instance can never repopulate what it just deleted.
  expect(() => client.open()).toThrow();
  await expect(client.clearLocalData()).rejects.toThrow();

  const storage = await IndexedDbReplicaStorage.open(name);
  try {
    const address = replicationActivationAddress({ server: OFFLINE, root: ROOT, graphPath: [] });
    const installed = await installClientCatalog(NotesCatalog);
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

// ── live lane, over the recorded real-Worker frames ────────────────────────

/**
 * The recording's catalog, as an application would author it.
 *
 * Duplicated rather than imported because the conformance catalog is a
 * deploy-time module: it imports `ramose`, which no browser bundle may. The
 * duplication is checked, not assumed — the first assertion below compares the
 * hash this catalog derives against the one the real Worker minted, so a schema
 * change that this copy misses fails loudly instead of quietly weakening the
 * suite. When it does, copy the declarations across and re-record.
 */
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
const ConformanceSchema = Schema({
  conformanceUser: ConformanceUser,
  conformanceIssue: ConformanceIssue,
});
const ConformanceCatalog = Catalog("local-conformance", {
  schema: ConformanceSchema,
  policy: compileReadAuthorization({ schema: ConformanceSchema, rules: [] }),
});

browserTest("derives the read compatibility the recorded Worker authenticated", async () => {
  const installed = await installClientCatalog(ConformanceCatalog);
  expect(installed.readCompatibilityHash).toBe(recorded.identity.readCompatibilityHash);
});

browserTest("a committed value enters a query already being observed", async ({ browser }) => {
  const name = `ramose-client-live-${browser.uniqueId}`;
  const client = createClient({
    url: globalThis.location.origin,
    // The recorded fixture is served at `/db/optimistic-fence/replicate`.
    root: "optimistic-fence",
    catalog: ConformanceCatalog,
    auth: () => Promise.resolve({ token: "session-credential", cacheKey: "recorded" }),
    storageName: name,
  });
  try {
    const db = client.open();
    const seen: string[] = [];
    client.sync.subscribe(() => seen.push(client.sync.getSnapshot().status));
    // Observed before anything is stored: the first value this query ever sees
    // arrives as a committed replica over the real session, with no server
    // query request of its own.
    const issues = db.observe(
      db.query.from(ConformanceIssue).select({ title: ConformanceIssue.title }),
    );
    expect(issues.getSnapshot().status).toBe("pending");

    const ready = await waitFor(issues, (snapshot) => snapshot.status === "ready");
    expect(ready.data).toBeInstanceOf(Array);
    expect((ready.data as readonly unknown[]).length).toBeGreaterThan(0);
    // Confirmed by the response that delivered it, so it is not stale.
    expect(ready.stale).toBe(false);
    expect(issues.getSnapshot()).toBe(ready);
    // The recording is one finite file, so the stream ends where a real one
    // would stay open; the client reports `live` while it is being read and
    // `offline` once the response is over, with the confirmed value intact.
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
  const installed = await installClientCatalog(ConformanceCatalog);
  // A complete, compatible replica for a *different* principal, bound to the
  // exact bearer this client presents. It is entitled to render stale offline —
  // and it must stop being readable the moment the server names another one.
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
      type: "SnapshotStart", protocol: 1, identity: prior, snapshot, revision,
    });
    await storage.stageSnapshotChunk({
      type: "SnapshotChunk", protocol: 1, identity: prior, snapshot, index: 0,
      datoms: [
        { entity, field: ":ramose/type", value: { type: "string", value: ":conformanceIssue" }, op: "add" },
        { entity, field: ":conformanceIssue/title", value: { type: "string", value: "prior-principal" }, op: "add" },
      ],
    });
    (await storage.commitSnapshot({
      type: "SnapshotCommit", protocol: 1, identity: prior, snapshot, revision, chunks: 1,
    }, installed.attributes))!.release();
    await storage.bindAuthenticated({
      fingerprint: await replicationCredentialFingerprint(
        "session-credential",
        replicationActivationAddress({
          server: globalThis.location.origin, root: "optimistic-fence", graphPath: [],
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
    catalog: ConformanceCatalog,
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
    // The prior partition really was rendered first — an exact bearer binding
    // is entitled to that — so the fence below is not a vacuous assertion.
    expect(seen.some((data) =>
      (data as readonly { readonly title: string }[] | undefined)
        ?.some((row) => row.title === "prior-principal") === true
    )).toBe(true);
    // The replaced principal's row is gone, and the transition was typed.
    expect(shown.some((row) => row.title === "prior-principal")).toBe(false);
    expect(statuses).toContain("authentication-required");
    // Every snapshot published after the fence dropped the prior partition.
    const fenced = seen.slice(seen.findIndex((data) => data === undefined) + 1);
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
