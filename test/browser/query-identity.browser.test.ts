import { expect } from "vitest";
import * as EffectSchema from "effect/Schema";
import {
  Entity,
  EntityId,
  Field,
  Ref,
  Schema,
  string,
} from "../../packages/ramose/src/db/internal.ts";
import {
  createClient,
  type Client,
  type ClientDatabase,
  type Subscription,
} from "../../packages/ramose/src/client/index.ts";
import { installClientCatalog } from "../../packages/ramose/src/client/catalog.ts";
import {
  isClientRef,
  type ClientRef,
  type EntityId as EntityIdentity,
} from "../../packages/ramose/src/db/refs.ts";
import { IndexedDbReplicaStorage } from "../../packages/ramose/src/internal/replication/indexeddb.ts";
import type {
  ReplicationIdentity,
  SnapshotDatom,
} from "../../packages/ramose/src/internal/replication/protocol.ts";
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
import { browserTest } from "./fixtures.ts";
import { snapshotChunk } from "../../packages/ramose/test/replication-fixtures.ts";

const Person = Entity("person", { name: Field.unique(string(), "strict") });

const Issue = Entity("issue", {
  title: string(),
  author: Ref(Person, { optional: true }),
}, {
  operations: (Operation) => ({
    createIssue: Operation({
      self: false,
      input: EffectSchema.Struct({
        title: EffectSchema.String,
        author: EntityId,
      }),
      output: EffectSchema.Struct({ id: EntityId }),
      allocates: { issue: ["id"] },
      optimistic: ({ input, tx }) => {
        const issue = tx.create("issue", Issue);
        tx.set(issue, Issue.title, input.title);
        tx.set(issue, Issue.author, input.author);
      },
      run(op, input) {
        return { id: op.create({ title: input.title, author: input.author }) };
      },
    }),
  }),
});

const AppSchema = Schema("query-identity", {
  person: Person,
  issue: Issue,
});
AppSchema.applyPolicy(() => {});

const OFFLINE = "http://127.0.0.1:1";
const ROOT = "app";
const TOKEN = "bearer-a";
const CACHE_KEY = "account-a";

const opaque = (character: string): string => character.repeat(43);

const serverIssuedHandle = (character: string): string =>
  `${character.repeat(54)}A`;

const ADA = serverIssuedHandle("a");
const BEN = serverIssuedHandle("b");
const SEEDED = serverIssuedHandle("c");
const OTHER = serverIssuedHandle("d");
const ELSEWHERE = serverIssuedHandle("z");

const REPLICA_PUBLISHED_HANDLE = /^[A-Za-z0-9_-]{54}[AEIMQUYcgkosw048]$/;

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

const seed = async (name: string): Promise<ReplicationIdentity> => {
  const installed = await installClientCatalog(AppSchema);
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
  const datoms: readonly SnapshotDatom[] = [
    { entity: ADA, field: ":ramose/type", value: { type: "string", value: ":person" }, op: "add" },
    { entity: ADA, field: ":person/name", value: { type: "string", value: "Ada" }, op: "add" },
    { entity: BEN, field: ":ramose/type", value: { type: "string", value: ":person" }, op: "add" },
    { entity: BEN, field: ":person/name", value: { type: "string", value: "Ben" }, op: "add" },
    { entity: SEEDED, field: ":ramose/type", value: { type: "string", value: ":issue" }, op: "add" },
    { entity: SEEDED, field: ":issue/title", value: { type: "string", value: "Seeded" }, op: "add" },
    { entity: SEEDED, field: ":issue/author", value: { type: "ref", value: ADA }, op: "add" },
    { entity: OTHER, field: ":ramose/type", value: { type: "string", value: ":issue" }, op: "add" },
    { entity: OTHER, field: ":issue/title", value: { type: "string", value: "Other" }, op: "add" },
    { entity: OTHER, field: ":issue/author", value: { type: "ref", value: BEN }, op: "add" },
  ];
  const storage = await IndexedDbReplicaStorage.open(name);
  try {
    const snapshot = opaque("q");
    const revision = opaque("r");
    await storage.startSnapshot({
      type: "SnapshotStart", protocol: 1, identity, snapshot, revision,
    });
    await storage.stageSnapshotChunk(snapshotChunk({
      type: "SnapshotChunk", protocol: 1, identity, snapshot, index: 0, datoms,
    }));
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
      fingerprint: await replicationCredentialFingerprint(TOKEN, address, routeSlot),
      identity,
      candidateKey: {
        selector: await replicationCacheSelector(CACHE_KEY, address),
        routeSlot,
      },
    });
  } finally {
    storage.close();
  }
  return identity;
};

const offlineClient = (name: string): Client =>
  createClient({
    url: OFFLINE,
    root: ROOT,
    catalog: AppSchema,
    auth: () => ({ token: TOKEN, cacheKey: CACHE_KEY }),
    storageName: name,
  });

type IssueRow = {
  readonly id: string;
  readonly data: {
    readonly title: string;
    readonly author: { readonly id: string } | undefined;
  };
};

const titlesOf = (rows: readonly IssueRow[]): readonly string[] =>
  rows.map((row) => row.data.title);

const ready = async (
  db: ClientDatabase,
  query: Parameters<ClientDatabase["observe"]>[0],
): Promise<readonly IssueRow[]> => {
  const observed = db.observe(query as never);
  const snapshot = await waitFor(
    observed as never,
    (value: { readonly status: string }) => value.status !== "pending",
  ) as { readonly status: string; readonly data: readonly IssueRow[]; readonly error?: Error };
  if (snapshot.status === "error") throw snapshot.error;
  return snapshot.data;
};

browserTest(
  "a handle a query published filters the next query, and one this replica does not hold answers nothing",
  async ({ browser }) => {
    const name = `ramose-query-identity-${browser.uniqueId}`;
    await seed(name);
    const client = offlineClient(name);
    try {
      const db = client.open();

      const all = await ready(db, db.query.from(Issue).orderBy(Issue.title));
      const seeded = all.find((row) => row.data.title === "Seeded")!;
      const ada = seeded.data.author!.id;
      const ben = all.find((row) => row.data.title === "Other")!.data.author!.id;

      expect(ada).toMatch(REPLICA_PUBLISHED_HANDLE);
      expect(ben).toMatch(REPLICA_PUBLISHED_HANDLE);
      expect(ada).not.toBe(ben);

      expect(
        titlesOf(await ready(db, db.query.from(Issue).where({ author: ada as never }))),
      ).toEqual(["Seeded"]);

      expect(
        titlesOf(await ready(db, db.query.from(Issue).where({ author: ben as never }))),
      ).toEqual(["Other"]);

      expect(
        await ready(db, db.query.from(Issue).where({ author: ELSEWHERE as never })),
      ).toEqual([]);

      expect(
        titlesOf(await ready(db, db.query.from(Issue).where({ id: seeded.id as never }))),
      ).toEqual(["Seeded"]);
    } finally {
      await client.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "a client ref names the optimistic entity it created, and filters by the author it was given",
  async ({ browser }) => {
    const name = `ramose-query-identity-optimistic-${browser.uniqueId}`;
    await seed(name);
    const client = offlineClient(name);
    try {
      const db = client.open();

      const all = await ready(db, db.query.from(Issue).orderBy(Issue.title));
      const ada = all.find((row) => row.data.title === "Seeded")!.data.author!.id;

      const receipt = db.mutate.createIssue({ title: "Local", author: ada as never });
      await receipt.queued;

      const byAda = await ready(
        db,
        db.query.from(Issue).where({ author: ada as never }).orderBy(Issue.title),
      );
      expect(titlesOf(byAda)).toEqual(["Local", "Seeded"]);

      const local = byAda.find((row) => row.data.title === "Local")!;
      expect(isClientRef(local.id)).toBe(true);

      const byRef = await ready(
        db,
        db.query.from(Issue).where({ id: local.id as ClientRef<typeof Issue> }),
      );
      expect(titlesOf(byRef)).toEqual(["Local"]);
    } finally {
      await client.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "a client ref follows the authoritative identity the moment one is issued",
  async ({ browser }) => {
    const name = `ramose-query-identity-mapped-${browser.uniqueId}`;
    const identity = await seed(name);
    const client = offlineClient(name);
    try {
      const db = client.open();

      const all = await ready(db, db.query.from(Issue).orderBy(Issue.title));
      const ada = all.find((row) => row.data.title === "Seeded")!.data.author!.id;
      const other = all.find((row) => row.data.title === "Other")!.id;

      await db.mutate.createIssue({ title: "Local", author: ada as never }).queued;

      const local = (await ready(
        db,
        db.query.from(Issue).where({ author: ada as never }).orderBy(Issue.title),
      )).find((row) => row.data.title === "Local")!.id as ClientRef<typeof Issue>;

      const observed = db.observe(db.query.from(Issue).where({ id: local }));
      const release = observed.subscribe(() => undefined);
      try {
        const speculative = await waitFor(
          observed as never,
          (value: { readonly status: string; readonly data?: readonly IssueRow[] }) =>
            value.status === "ready" && value.data?.length === 1,
        ) as { readonly data: readonly IssueRow[] };
        expect(speculative.data[0]!.id).toBe(local);

        const storage = await IndexedDbReplicaStorage.open(name);
        try {
          const outbox = storage.outbox();
          const { records } = await outbox.restore(replicaScopeOf(identity));
          await outbox.recordMappings(
            replicaDatabaseScopeOf(identity),
            records[0]!.invocation,
            [{ clientRef: local, entityId: other as EntityIdentity }],
          );
        } finally {
          storage.close();
        }

        const confirmed = await waitFor(
          observed as never,
          (value: { readonly status: string; readonly data?: readonly IssueRow[] }) =>
            value.status === "ready" && value.data?.[0]?.id === other,
        ) as { readonly data: readonly IssueRow[] };
        expect(confirmed.data).toHaveLength(1);
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
  "an entity identity where no entity can be held is refused rather than answered emptily",
  async ({ browser }) => {
    const name = `ramose-query-identity-refused-${browser.uniqueId}`;
    await seed(name);
    const client = offlineClient(name);
    try {
      const db = client.open();
      await ready(db, db.query.from(Issue));

      expect(() =>
        db.observe(db.query.from(Issue).where({ title: ADA as never }))
      ).toThrow(/an entity identity is not a value/);
    } finally {
      await client.close();
      await deleteDatabase(name);
    }
  },
);
