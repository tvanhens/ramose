
import { expect } from "vitest";
import * as EffectSchema from "effect/Schema";
import { Catalog } from "../../packages/ramose/src/Catalog.ts";
import {
  Entity,
  Field,
  Graph,
  Ref,
  Schema,
  string,
  type CodeDefinition,
} from "../../packages/ramose/src/db/internal.ts";
import { compileReadAuthorization } from "../../packages/ramose/src/internal/authorization/index.ts";
import { ReadCompatibilityHash } from "../../packages/ramose/src/internal/authorization/identities.ts";
import { createClient, type Client } from "../../packages/ramose/src/client/index.ts";
import { installClientCatalog } from "../../packages/ramose/src/client/catalog.ts";
import { IndexedDbReplicaStorage } from "../../packages/ramose/src/internal/replication/indexeddb.ts";
import type { ReplicationIdentity } from "../../packages/ramose/src/internal/replication/protocol.ts";
import { rootReplicaRouteSlot } from "../../packages/ramose/src/internal/replication/route-slot.ts";
import {
  replicationActivationAddress,
  replicationCredentialFingerprint,
} from "../../packages/ramose/src/internal/replication/transport.ts";
import { replicaScopeOf } from "../../packages/ramose/src/internal/replication/replica-lifecycle.ts";
import { isInvocationId } from "../../packages/ramose/src/db/refs.ts";
import { Query as PortableQuery } from "../../packages/ramose/src/db/internal.ts";
import { browserTest } from "./fixtures.ts";
import { snapshotChunk } from "../../packages/ramose/test/replication-fixtures.ts";

const Child = { key: "child", schema: Schema({}) } satisfies CodeDefinition;

const Person = Entity("person", { name: string() });

const Issue = Entity("issue", {
  title: Field.unique(string(), "strict"),
  author: Ref(Person, { optional: true }),
}, {
  operations: (Operation) => ({
    createIssue: Operation({
      self: false,
      input: EffectSchema.Struct({ title: EffectSchema.String }),
      output: EffectSchema.Struct({}),
      run() {
        return {};
      },
    }),
    close: Operation({
      input: EffectSchema.Struct({}),
      output: EffectSchema.Struct({}),
      run() {
        return {};
      },
    }),
    annotate: Operation({
      input: EffectSchema.NullOr(EffectSchema.Struct({ note: EffectSchema.String })),
      output: EffectSchema.Struct({}),
      run() {
        return {};
      },
    }),
  }),
});

const Organization = Entity("organization", {
  slug: Field.unique(string(), "strict"),
}, { traits: [Graph(Child)] });

const AppSchema = Schema({
  person: Person,
  issue: Issue,
  organization: Organization,
});
const AppCatalog = Catalog("client-mutate", {
  schema: AppSchema,
  policy: compileReadAuthorization({ schema: AppSchema, rules: [] }),
});

const OFFLINE = "http://127.0.0.1:1";
const ROOT = "app";
const TOKEN = "bearer-a";
const CACHE_KEY = "account-a";

const opaque = (character: string): string => character.repeat(43);

/** A sealed entity handle: 55 canonical base64url characters. */
const SEALED = /^[A-Za-z0-9_-]{54}[AEIMQUYcgkosw048]$/;

const deleteDatabase = (name: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.addEventListener("success", () => resolve(), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });

const MUTATION_STORES = [
  "mutation-outbox-v1",
  "mutation-queues-v1",
  "mutation-receipts-v1",
  "mutation-client-refs-v1",
  "mutation-client-ref-mappings-v1",
  "mutation-layers-v1",
] as const;

const mutationCensus = async (
  name: string,
): Promise<Record<string, number>> => {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name);
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });
  try {
    const present = MUTATION_STORES.filter((store) =>
      database.objectStoreNames.contains(store)
    );
    const census: Record<string, number> = {};
    for (const store of MUTATION_STORES) census[store] = 0;
    if (present.length === 0) return census;
    const transaction = database.transaction(present, "readonly");
    await Promise.all(present.map((store) =>
      new Promise<void>((resolve, reject) => {
        const request = transaction.objectStore(store).count();
        request.addEventListener("success", () => {
          census[store] = request.result;
          resolve();
        }, { once: true });
        request.addEventListener("error", () => reject(request.error), { once: true });
      })
    ));
    return census;
  } finally {
    database.close();
  }
};

const NO_MUTATION_TRACE: Record<string, number> = Object.fromEntries(
  MUTATION_STORES.map((store) => [store, 0]),
);

const waitFor = <A>(
  subscription: { subscribe: (f: () => void) => () => void; getSnapshot: () => A },
  accept: (value: A) => boolean,
): Promise<A> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      release();
      reject(new Error(`timed out at ${JSON.stringify(subscription.getSnapshot())}`));
    }, 10_000);
    const settle = (): void => {
      const value = subscription.getSnapshot();
      if (!accept(value)) return;
      clearTimeout(timer);
      release();
      resolve(value);
    };
    const release = subscription.subscribe(settle);
    settle();
  });

const client = (name: string): Client =>
  createClient({
    url: OFFLINE,
    root: ROOT,
    catalog: AppCatalog,
    auth: () => ({ token: TOKEN, cacheKey: CACHE_KEY }),
    storageName: name,
  });

const seedRoot = async (name: string): Promise<ReplicationIdentity> => {
  const installed = await installClientCatalog(AppCatalog);
  const identity: ReplicationIdentity = {
    version: 1,
    server: opaque("s"),
    principal: opaque("p"),
    database: opaque("d"),
    catalog: opaque("c"),
    readView: opaque("v"),
    readCompatibilityHash: ReadCompatibilityHash.make(
      installed.readCompatibilityHash,
    ),
    graphLineage: [],
    authenticator: opaque("a"),
  };
  const storage = await IndexedDbReplicaStorage.open(name);
  try {
    const snapshot = opaque("q");
    const revision = opaque("r");
    await storage.startSnapshot({
      type: "SnapshotStart", protocol: 1, identity, snapshot, revision,
    });
    await storage.stageSnapshotChunk(snapshotChunk({
      type: "SnapshotChunk", protocol: 1, identity, snapshot, index: 0,
      datoms: [
        { entity: opaque("p"), field: ":ramose/type", value: { type: "string", value: ":person" }, op: "add" },
        { entity: opaque("p"), field: ":person/name", value: { type: "string", value: "Ada" }, op: "add" },
        { entity: opaque("e"), field: ":ramose/type", value: { type: "string", value: ":issue" }, op: "add" },
        { entity: opaque("e"), field: ":issue/title", value: { type: "string", value: "Seeded" }, op: "add" },
        { entity: opaque("e"), field: ":issue/author", value: { type: "ref", value: opaque("p") }, op: "add" },
      ],
    }));
    const committed = await storage.commitSnapshot({
      type: "SnapshotCommit", protocol: 1, identity, snapshot, revision, chunks: 1,
    }, installed.attributes);
    expect(committed).toBeDefined();
    committed!.release();
    await storage.bindAuthenticated({
      fingerprint: await replicationCredentialFingerprint(
        TOKEN,
        replicationActivationAddress({ server: OFFLINE, root: ROOT, graphPath: [] }),
        await rootReplicaRouteSlot(),
      ),
      identity,
    });
  } finally {
    storage.close();
  }
  return identity;
};

const queued = async (name: string, identity: ReplicationIdentity) => {
  const storage = await IndexedDbReplicaStorage.open(name);
  try {
    return (await storage.outbox().restore(replicaScopeOf(identity))).records;
  } finally {
    storage.close();
  }
};

browserTest(
  "a fresh client whose credential is refused fails its mutations",
  async ({ browser }) => {
    // No seeded replica, which is the whole point: every other test here starts
    // from a database that has already synchronized once, so the path where a
    // client's very first activation fails was never walked. An expired refresh
    // token at boot reaches it, and so does a browser that refuses storage.
    //
    // A refused credential is not an unreachable network. Reported as `offline`
    // it would leave the receiver waiting for an identity that cannot arrive,
    // and since the activation is memoized nothing would ever try again — the
    // mutation's promises would hang for the life of the page.
    const name = `ramose-mutate-fresh-refused-${browser.uniqueId}`;
    const app = createClient({
      url: OFFLINE,
      root: ROOT,
      catalog: AppCatalog,
      auth: () => {
        throw new Error("refresh token expired");
      },
      storageName: name,
    });
    try {
      const db = app.open();
      const receipt = db.mutate.createIssue({ title: "Offline" });

      await expect(receipt.queued).rejects.toMatchObject({
        _tag: "GraphReceiverError",
        reason: "unauthorized",
      });
      expect(receipt.getSnapshot().status).toBe("failed");
      expect(db.sync.getSnapshot().status).toBe("authentication-required");

      expect(await mutationCensus(name)).toEqual(NO_MUTATION_TRACE);
    } finally {
      await app.close();
      await deleteDatabase(name);
    }
  },
);

browserTest("a targetless mutation queues durably and reports it", async ({ browser }) => {
  const name = `ramose-mutate-queued-${browser.uniqueId}`;
  const identity = await seedRoot(name);
  const app = client(name);
  try {
    const db = app.open();
    expect(typeof db.mutate.createIssue).toBe("function");
    expect(Object.keys(db.mutate)).toEqual(["createIssue"]);

    const receipt = db.mutate.createIssue({ title: "Offline" });
    expect(isInvocationId(receipt.invocation)).toBe(true);
    expect(receipt.getSnapshot()).toEqual({ status: "pending" });

    await receipt.queued;
    expect(receipt.getSnapshot()).toEqual({ status: "queued" });

    const records = await queued(name, identity);
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.invocation).toBe(receipt.invocation);
    expect(record.operation).toMatchObject({
      catalog: "client-mutate",
      owner: { kind: "entity", name: "issue" },
      localName: "createIssue",
    });
    expect(record.operationVersion).toMatch(/^[0-9a-f]{64}$/);
    expect(record.target).toEqual({ type: "none" });
    expect(record.input).toEqual({ title: "Offline" });
    expect(record.receiver).toEqual({
      server: identity.server,
      principal: identity.principal,
      database: identity.database,
    });
    expect(JSON.stringify(record)).not.toContain("unitHash");

    expect(receipt.getSnapshot().status).toBe("queued");
    expect(await mutationCensus(name)).toEqual({
      ...NO_MUTATION_TRACE,
      "mutation-outbox-v1": 1,
      "mutation-queues-v1": 1,
      "mutation-receipts-v1": 1,
    });
  } finally {
    await app.close();
    await deleteDatabase(name);
  }
});

browserTest(
  "a renewed bearer still submits, and another account does not",
  async ({ browser }) => {
    const name = `ramose-mutate-rotation-${browser.uniqueId}`;
    await seedRoot(name);
    let token = TOKEN;
    const app = createClient({
      url: OFFLINE,
      root: ROOT,
      catalog: AppCatalog,
      auth: () => ({ token, cacheKey: CACHE_KEY }),
      storageName: name,
    });
    try {
      const db = app.open();
      await db.mutate.createIssue({ title: "Offline" }).queued;
      const handle = db as unknown as {
        authenticatedBy: (credential: { readonly cacheKey: string }) => boolean;
      };

      expect(handle.authenticatedBy({ cacheKey: CACHE_KEY })).toBe(true);
      token = "bearer-renewed";
      expect(handle.authenticatedBy({ cacheKey: CACHE_KEY })).toBe(true);
      expect(handle.authenticatedBy({ cacheKey: "account-b" })).toBe(false);
    } finally {
      await app.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "a queued invocation this deployment cannot run says so on `sync`",
  async ({ browser }) => {
    const name = `ramose-mutate-quarantine-${browser.uniqueId}`;
    const identity = await seedRoot(name);
    const app = client(name);
    try {
      const db = app.open();
      const receipt = db.mutate.createIssue({ title: "Offline" });
      await receipt.queued;
      await waitFor(db.sync, (state) => state.status !== "idle");

      await (db as unknown as {
        reconcileSubmissions: (progress: readonly unknown[]) => Promise<void>;
      }).reconcileSubmissions([{
        partition: "quarantine",
        receiver: {
          server: identity.server,
          principal: identity.principal,
          database: identity.database,
        },
        state: {
          _tag: "UpdateRequired",
          invocation: receipt.invocation,
          reason: "operation-changed",
        },
      }]);

      expect(db.sync.getSnapshot().status).toBe("update-required");
      expect(receipt.getSnapshot().status).toBe("queued");
      expect(await queued(name, identity)).toHaveLength(1);
    } finally {
      await app.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "an unresolvable receiver fails before anything durable exists",
  async ({ browser }) => {
    const name = `ramose-mutate-unresolved-${browser.uniqueId}`;
    const identity = await seedRoot(name);
    const app = client(name);
    try {
      const db = app.open();
      const missing = db.query
        .from(Organization).where({ slug: "absent" }).one().db();

      const receipt = missing.mutate.createIssue({ title: "Never queued" });
      await expect(receipt.queued).rejects.toMatchObject({
        _tag: "GraphReceiverError",
        reason: "unresolved",
      });
      await expect(receipt.committed).rejects.toMatchObject({
        _tag: "GraphReceiverError",
      });
      const state = receipt.getSnapshot();
      expect(state.status).toBe("failed");

      expect(await queued(name, identity)).toHaveLength(0);
      expect(await mutationCensus(name)).toEqual(NO_MUTATION_TRACE);
    } finally {
      await app.close();
      await deleteDatabase(name);
    }
  },
);

browserTest("an entity-focused query returns live handles", async ({ browser }) => {
  const name = `ramose-mutate-handles-${browser.uniqueId}`;
  await seedRoot(name);
  const app = client(name);
  try {
    const db = app.open();
    const issues = db.observe(db.query.from(Issue));
    const stop = issues.subscribe(() => undefined);
    const ready = await waitFor(issues, (snapshot) => snapshot.status === "ready");
    const rows = ready.data!;
    expect(rows).toHaveLength(1);
    const issue = rows[0]!;

    expect(issue.id).toMatch(SEALED);

    expect(issue.data).toMatchObject({ id: issue.id, title: "Seeded" });
    expect(structuredClone(issue.data)).toEqual(issue.data);
    for (const value of Object.values(issue.data as Record<string, unknown>)) {
      expect(typeof value).not.toBe("function");
    }

    expect(issue.local).toEqual({ pending: false, created: false });

    expect(Object.keys(issue.mutate).sort()).toEqual(["annotate", "close"]);

    const again = await waitFor(issues, (snapshot) => snapshot.status === "ready");
    expect(again.data![0]).toBe(issue);
    stop();
  } finally {
    await app.close();
    await deleteDatabase(name);
  }
});

browserTest("a projection returns plain rows, not handles", async ({ browser }) => {
  const name = `ramose-mutate-projection-${browser.uniqueId}`;
  await seedRoot(name);
  const app = client(name);
  try {
    const db = app.open();
    const titles = db.observe(db.query.from(Issue).select({ title: Issue.title }));
    const stop = titles.subscribe(() => undefined);
    const ready = await waitFor(titles, (snapshot) => snapshot.status === "ready");
    expect(ready.data).toEqual([{ title: "Seeded" }]);
    stop();
  } finally {
    await app.close();
    await deleteDatabase(name);
  }
});

browserTest("a paged entity query returns a page of handles", async ({ browser }) => {
  const name = `ramose-mutate-paged-${browser.uniqueId}`;
  await seedRoot(name);
  const app = client(name);
  try {
    const db = app.open();
    const page = db.observe(
      db.query.from(Issue).orderBy(Issue.title).limit(1).after(null),
    );
    const stop = page.subscribe(() => undefined);
    const ready = await waitFor(page, (snapshot) => snapshot.status === "ready");
    const rows = ready.data!.rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.data).toMatchObject({ id: rows[0]!.id, title: "Seeded" });
    expect(Object.keys(rows[0]!.mutate).sort()).toEqual(["annotate", "close"]);
    // The tie-breaker is the paging root's identity, so a full page's cursor
    // always carries one — matched against the sealed shape rather than merely
    // "not a number", which a stringified eid would also satisfy.
    expect(ready.data!.cursor?.keys).toHaveLength(2);
    expect(ready.data!.cursor!.keys.filter((key) =>
      typeof key === "string" && SEALED.test(key)
    )).toHaveLength(1);
    stop();

    const byAuthor = db.observe(
      db.query.from(Issue).orderBy(Issue.author).limit(1).after(null),
    );
    const stopByAuthor = byAuthor.subscribe(() => undefined);
    const sorted = await waitFor(byAuthor, (snapshot) => snapshot.status === "ready");
    const cursor = sorted.data!.cursor;
    // Both cells are identities here — the reference sort key and the root
    // tie-breaker — so both must be sealed handles.
    expect(cursor?.keys).toHaveLength(2);
    for (const key of cursor!.keys) expect(key).toMatch(SEALED);

    const next = db.observe(
      db.query.from(Issue).orderBy(Issue.author).limit(1).after(cursor),
    );
    const stopNext = next.subscribe(() => undefined);
    await waitFor(next, (snapshot) => snapshot.status !== "pending");
    expect(next.getSnapshot().error).toBeUndefined();
    stopNext();
    stopByAuthor();
  } finally {
    await app.close();
    await deleteDatabase(name);
  }
});

browserTest(
  "closing while a graph path is unresolved settles its receipt",
  async ({ browser }) => {
    const name = `ramose-mutate-close-unresolved-${browser.uniqueId}`;
    const identity = await seedRoot(name);
    const app = client(name);
    const db = app.open();
    try {
      const child = db.query
        .from(Organization)
        .where({ slug: "never-resolves" })
        .one()
        .db();
      const receipt = child.mutate.createIssue({ title: "Offline" });

      await app.close();

      await expect(receipt.queued).rejects.toMatchObject({
        _tag: "GraphReceiverError",
        reason: "closed",
      });
      await expect(receipt.committed).rejects.toMatchObject({
        _tag: "GraphReceiverError",
      });
      expect(receipt.getSnapshot().status).toBe("failed");
      expect(await queued(name, identity)).toHaveLength(0);
      expect(await mutationCensus(name)).toEqual(NO_MUTATION_TRACE);
    } finally {
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "a waiting receipt settles without waiting for close() to finish draining",
  async ({ browser }) => {
    const name = `ramose-mutate-close-drain-${browser.uniqueId}`;
    const identity = await seedRoot(name);
    const app = client(name);
    try {
      const db = app.open();
      const issues = db.observe(
        db.query.from(Issue).orderBy(Issue.title).select({ title: Issue.title }),
      );
      const held = issues.subscribe(() => undefined);
      await waitFor(issues, (snapshot) => snapshot.status === "ready");
      await waitFor(db.sync, (state) => state.status === "offline");

      const waiting = db.query
        .from(Organization)
        .where({ slug: "never-resolves" })
        .one()
        .db()
        .mutate.createIssue({ title: "Waiting" });

      held();
      const rerunning = issues.subscribe(() => undefined);

      const closing = app.close();

      await expect(waiting.queued).rejects.toMatchObject({
        _tag: "GraphReceiverError",
        reason: "closed",
      });
      await expect(waiting.committed).rejects.toMatchObject({
        _tag: "GraphReceiverError",
      });
      expect(waiting.getSnapshot().status).toBe("failed");

      await closing;
      rerunning();

      expect(db.sync.getSnapshot().status).toBe("closed");
      expect(await queued(name, identity)).toHaveLength(0);
      expect(await mutationCensus(name)).toEqual(NO_MUTATION_TRACE);
    } finally {
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "a committed acknowledgement settles its receipt and keeps held handles",
  async ({ browser }) => {
    const name = `ramose-mutate-restart-${browser.uniqueId}`;
    const identity = await seedRoot(name);
    const app = client(name);
    try {
      const db = app.open();
      const issues = db.observe(db.query.from(Issue));
      const stop = issues.subscribe(() => undefined);
      const ready = await waitFor(issues, (snapshot) => snapshot.status === "ready");
      const held = ready.data![0]!;
      expect(Object.keys(held.mutate).sort()).toEqual(["annotate", "close"]);

      // An operation whose whole input is optional queues with no argument,
      // and a supplied null is a value rather than an absent argument.
      const annotated = held.mutate.annotate(null);
      await annotated.queued;
      expect((await queued(name, identity))[0]!.input).toBeNull();

      const receipt = held.mutate.close();
      await receipt.queued;
      expect(receipt.getSnapshot().status).toBe("queued");
      expect(
        (await queued(name, identity)).map((record) => record.input),
      ).toEqual([null, {}]);

      const seen: string[] = [];
      const watchSync = db.sync.subscribe(() => {
        seen.push(db.sync.getSnapshot().status);
      });
      const loop = (app as unknown as {
        submissions: () => {
          settle: (progress: readonly unknown[]) => Promise<void>;
        };
      }).submissions();
      await loop.settle([{
        partition: "restart",
        receiver: {
          server: identity.server,
          principal: identity.principal,
          database: identity.database,
        },
        state: { _tag: "Committed", invocation: receipt.invocation },
      }]);

      watchSync();
      // The reopen is a reconnect over a value this handle is still
      // publishing — the same held row the assertions below read — which is
      // what `stale` means and what `connecting` denies.
      expect(seen).toContain("stale");

      await receipt.committed;
      expect(receipt.getSnapshot().status).toBe("committed");

      const after = await waitFor(issues, (snapshot) => snapshot.status === "ready");
      expect(after.data![0]).toBe(held);
      expect(held.data).toMatchObject({ id: held.id, title: "Seeded" });
      expect(Object.keys(held.mutate).sort()).toEqual(["annotate", "close"]);
      stop();
    } finally {
      await app.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "an entity query and the same portable query do not share an observation",
  async ({ browser }) => {
    const name = `ramose-mutate-interning-${browser.uniqueId}`;
    await seedRoot(name);
    const app = client(name);
    try {
      const db = app.open();
      const handles = db.observe(db.query.from(Issue));
      const plain = db.observe(PortableQuery.from(Issue));
      const stopHandles = handles.subscribe(() => undefined);
      const stopPlain = plain.subscribe(() => undefined);
      const shaped = await waitFor(handles, (s) => s.status === "ready");
      const rows = await waitFor(plain, (s) => s.status === "ready");

      expect(shaped.data![0]!.data).toMatchObject({ id: shaped.data![0]!.id, title: "Seeded" });
      expect(rows.data![0]).toMatchObject({ id: shaped.data![0]!.id, title: "Seeded" });
      expect(rows.data![0]).not.toHaveProperty("mutate");
      stopHandles();
      stopPlain();
    } finally {
      await app.close();
      await deleteDatabase(name);
    }
  },
);
