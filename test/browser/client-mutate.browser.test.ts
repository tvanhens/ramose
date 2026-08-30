
import { expect } from "vitest";
import * as EffectSchema from "effect/Schema";
import { Catalog } from "../../packages/ramose/src/Catalog.ts";
import {
  Entity,
  Field,
  Graph,
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
import { browserTest } from "./fixtures.ts";
import { snapshotChunk } from "../../packages/ramose/test/replication-fixtures.ts";

const Child = { key: "child", schema: Schema({}) } satisfies CodeDefinition;

const Issue = Entity("issue", {
  title: Field.unique(string(), "strict"),
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
  }),
});

const Organization = Entity("organization", {
  slug: Field.unique(string(), "strict"),
}, { traits: [Graph(Child)] });

const AppSchema = Schema({ issue: Issue, organization: Organization });
const AppCatalog = Catalog("client-mutate", {
  schema: AppSchema,
  policy: compileReadAuthorization({ schema: AppSchema, rules: [] }),
});

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
        { entity: opaque("e"), field: ":ramose/type", value: { type: "string", value: ":issue" }, op: "add" },
        { entity: opaque("e"), field: ":issue/title", value: { type: "string", value: "Seeded" }, op: "add" },
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

      // And nothing durable was written for an invocation that never had a
      // receiver: no outbox row, and no client ref claimed by one.
      const storage = await IndexedDbReplicaStorage.open(name);
      try {
        expect(await storage.outbox().restore({
          server: opaque("s"),
          principal: opaque("p"),
        }).then((restored) => restored.records)).toHaveLength(0);
      } finally {
        storage.close();
      }
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
      const storage = await IndexedDbReplicaStorage.open(name);
      try {
        expect(await storage.outbox().mappedRefs(replicaScopeOf(identity)))
          .toEqual(new Map());
      } finally {
        storage.close();
      }
    } finally {
      await app.close();
      await deleteDatabase(name);
    }
  },
);
