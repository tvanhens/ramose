import { expect } from "vitest";
import {
  Entity,
  Field,
  Graph,
  Schema,
  string,
  type CodeDefinition,
} from "../../packages/ramose/src/db/internal.ts";
import {
  createClient,
  GraphPathError,
  type Client,
  type ClientDatabase,
  type Subscription,
} from "../../packages/ramose/src/client/index.ts";
import { installClientCatalog } from "../../packages/ramose/src/client/catalog.ts";
import { IndexedDbReplicaStorage } from "../../packages/ramose/src/internal/replication/indexeddb.ts";
import type {
  ReplicationIdentity,
  SnapshotDatom,
} from "../../packages/ramose/src/internal/replication/protocol.ts";
import {
  replicaRoutePathKey,
  replicaRouteScope,
  rootReplicaRouteSlot,
  stableReplicaRouteSlot,
  type ReplicaRouteSlot,
} from "../../packages/ramose/src/internal/replication/route-slot.ts";
import {
  replicationActivationAddress,
  replicationCredentialFingerprint,
} from "../../packages/ramose/src/internal/replication/transport.ts";
import { browserTest } from "./fixtures.ts";
import { snapshotChunk } from "../../packages/ramose/test/replication-fixtures.ts";

const Child = Schema("child", {}) satisfies CodeDefinition;
Child.applyPolicy(() => {});

const Organization = Entity("organization", {
  slug: Field.unique(string(), "strict"),
  region: string(),
}, { traits: [Graph(Child)] });

const Board = Entity("board", {
  slug: Field.unique(string(), "strict"),
}, { traits: [Graph(Child)] });

const Issue = Entity("issue", {
  title: Field.unique(string(), "strict"),
  rank: string(),
});

const AppSchema = Schema("client-graph", {
  organization: Organization,
  board: Board,
  issue: Issue,
});
AppSchema.applyPolicy(() => {});

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

const settled = async (client: Client): Promise<void> => {
  await waitFor(client.sync, (state) =>
    state.status === "offline" || state.status === "closed");
  for (let turn = 0; turn < 40; turn++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 50));
};

const identityFor = (
  database: string,
  lineage: readonly string[],
  readCompatibilityHash: string,
  readView = opaque("v"),
): ReplicationIdentity => ({
  version: 1,
  server: opaque("s"),
  principal: opaque("p"),
  database,
  catalog: opaque("c"),
  readView,
  readCompatibilityHash: readCompatibilityHash as ReplicationIdentity["readCompatibilityHash"],
  graphLineage: lineage,
  authenticator: opaque("a"),
});

type Seed = {
  readonly graphPath: readonly string[];
  readonly identity: ReplicationIdentity;
  readonly datoms: readonly SnapshotDatom[];

  readonly observeRoute?: boolean;
  readonly token?: string;
};

const slotFor = (seed: Seed): Promise<ReplicaRouteSlot> =>
  seed.graphPath.length === 0
    ? rootReplicaRouteSlot()
    : stableReplicaRouteSlot(seed.identity.graphLineage);

const seed = async (name: string, seeds: readonly Seed[]): Promise<void> => {
  const installed = await installClientCatalog(AppSchema);
  const storage = await IndexedDbReplicaStorage.open(name);
  try {
    for (const entry of seeds) {
      const identity = entry.identity;
      const snapshot = opaque("q");
      const revision = opaque("r");
      await storage.startSnapshot({
        type: "SnapshotStart", protocol: 2, identity, snapshot, revision,
      });
      await storage.stageSnapshotChunk(snapshotChunk({
        type: "SnapshotChunk", protocol: 2, identity, snapshot, index: 0,
        datoms: entry.datoms,
      }));
      const committed = await storage.commitSnapshot({
        type: "SnapshotCommit", protocol: 2, identity, snapshot, revision, ordinal: 1, chunks: 1,
      }, installed.attributes);
      expect(committed).toBeDefined();
      committed!.release();
      const address = replicationActivationAddress({
        server: OFFLINE, root: ROOT, graphPath: entry.graphPath,
      });
      const slot = await slotFor(entry);
      await storage.bindAuthenticated({
        fingerprint: await replicationCredentialFingerprint(
          entry.token ?? TOKEN,
          address,
          slot,
        ),
        identity,
        ...(entry.graphPath.length === 0 || entry.observeRoute === false
          ? {}
          : {
            route: {
              scope: await replicaRouteScope(address),
              pathKey: await replicaRoutePathKey(entry.graphPath),
              slot,
            },
          }),
      });
    }
  } finally {
    storage.close();
  }
};

const typed = (entity: string, type: string): SnapshotDatom => ({
  entity,
  field: ":ramose/type",
  value: { type: "string", value: type },
  op: "add",
});

const fact = (entity: string, field: string, value: string): SnapshotDatom => ({
  entity, field, value: { type: "string", value }, op: "add",
});

const graphRow = (
  entity: string,
  type: string,
  slugField: string,
  slug: string,
  name: string,
  extra: readonly SnapshotDatom[] = [],
): readonly SnapshotDatom[] => [
  typed(entity, type),
  fact(entity, slugField, slug),
  fact(entity, ":graph/catalog", "child"),
  fact(entity, ":graph/name", name),
  ...extra,
];

const offlineClient = (
  name: string,
  credential = { token: TOKEN, cacheKey: CACHE_KEY },
): Client =>
  createClient({
    url: OFFLINE,
    root: ROOT,
    catalog: AppSchema,
    auth: () => credential,
    storageName: name,
  });

const ORG_LINEAGE = [opaque("1")];
const BOARD_LINEAGE = [opaque("1"), opaque("2")];

const nested = async (
  name: string,
  options: { readonly boards?: boolean } = {},
): Promise<void> => {
  const installed = await installClientCatalog(AppSchema);
  const hash = installed.readCompatibilityHash;
  await seed(name, [
    {
      graphPath: [],
      identity: identityFor(opaque("R"), [], hash),
      datoms: [
        ...graphRow(opaque("e"), ":organization", ":organization/slug", "acme", "acme-org", [
          fact(opaque("e"), ":organization/region", "eu"),
        ]),
      ],
    },
    {
      graphPath: ["acme-org"],
      identity: identityFor(opaque("O"), ORG_LINEAGE, hash),
      datoms: [
        ...graphRow(opaque("f"), ":board", ":board/slug", "roadmap", "roadmap-board"),
      ],
      observeRoute: options.boards !== false,
    },
    {
      graphPath: ["acme-org", "roadmap-board"],
      identity: identityFor(opaque("B"), BOARD_LINEAGE, hash),
      datoms: [
        typed(opaque("g"), ":issue"),
        fact(opaque("g"), ":issue/title", "offline"),
        fact(opaque("g"), ":issue/rank", "a"),
      ],
      observeRoute: options.boards !== false,
    },
  ]);
};

const orgHandle = (db: ClientDatabase): ClientDatabase =>
  db.query.from(Organization).where({ slug: "acme" }).one().db();

const boardHandle = (db: ClientDatabase): ClientDatabase =>
  orgHandle(db).query.from(Board).where({ slug: "roadmap" }).one().db();

const issues = (db: ClientDatabase) =>
  db.observe(db.query.from(Issue).orderBy(Issue.rank).select({ title: Issue.title }));

browserTest("activates a nested path ancestor by ancestor, offline", async ({ browser }) => {
  const name = `ramose-graph-nested-${browser.uniqueId}`;
  await nested(name);
  const client = offlineClient(name);
  try {
    const db = client.open();

    const board = boardHandle(db);
    expect(client.sync.getSnapshot().status).toBe("idle");

    const open = issues(board);
    expect(open.getSnapshot().status).toBe("pending");
    const held = open.subscribe(() => undefined);

    const ready = await waitFor(open, (snapshot) => snapshot.status === "ready");
    expect(ready.data).toEqual([{ title: "offline" }]);
    expect(ready.stale).toBe(true);
    expect(open.getSnapshot()).toBe(ready);
    expect(await waitFor(client.sync, (state) => state.status === "offline"))
      .toBeDefined();

    const boards = orgHandle(db).observe(
      orgHandle(db).query.from(Board).select({ slug: Board.slug }),
    );
    const holdBoards = boards.subscribe(() => undefined);
    expect((await waitFor(boards, (snapshot) => snapshot.status === "ready")).data)
      .toEqual([{ slug: "roadmap" }]);

    expect(boardHandle(db)).toBe(board);
    expect(issues(boardHandle(db)).getSnapshot()).toBe(ready);
    holdBoards();
    held();
  } finally {
    await client.close();
    await deleteDatabase(name);
  }
});

browserTest("keeps a cold nested query pending, never partial", async ({ browser }) => {
  const name = `ramose-graph-cold-${browser.uniqueId}`;

  const installed = await installClientCatalog(AppSchema);
  await seed(name, [{
    graphPath: [],
    identity: identityFor(opaque("R"), [], installed.readCompatibilityHash),
    datoms: graphRow(opaque("e"), ":organization", ":organization/slug", "acme", "acme-org"),
  }]);
  const client = offlineClient(name);
  try {
    const db = client.open();
    const open = issues(boardHandle(db));
    const held = open.subscribe(() => undefined);
    await settled(client);

    expect(open.getSnapshot().status).toBe("pending");
    expect(open.getSnapshot().data).toBeUndefined();

    const org = orgHandle(db);
    const boards = org.observe(org.query.from(Board).select({ slug: Board.slug }));
    const holdBoards = boards.subscribe(() => undefined);
    await settled(client);
    expect(boards.getSnapshot().status).toBe("pending");
    holdBoards();
    held();
  } finally {
    await client.close();
    await deleteDatabase(name);
  }
});

browserTest("collapses zero and hidden matches into one opaque unavailable result", async ({ browser }) => {
  const name = `ramose-graph-unavailable-${browser.uniqueId}`;
  await nested(name);
  const client = offlineClient(name);
  try {
    const db = client.open();

    const absent = db.query.from(Organization).where({ slug: "ghost" }).one().db();
    const withheld = db.query.from(Organization).where({ slug: "private" }).one().db();
    const one = absent.observe(absent.query.from(Board).select({ slug: Board.slug }));
    const two = withheld.observe(withheld.query.from(Board).select({ slug: Board.slug }));
    const holds = [one.subscribe(() => undefined), two.subscribe(() => undefined)];

    const failed = await waitFor(one, (snapshot) => snapshot.status === "error");
    await waitFor(two, (snapshot) => snapshot.status === "error");
    expect(failed.data).toBeUndefined();
    expect(failed.error).toBeInstanceOf(GraphPathError);
    expect((failed.error as GraphPathError).reason).toBe("unavailable");

    expect((two.getSnapshot().error as GraphPathError).reason)
      .toBe((failed.error as GraphPathError).reason);
    expect(two.getSnapshot().error?.message).toBe(failed.error?.message);

    expect(one.getSnapshot()).toBe(failed);
    for (const release of holds) release();
  } finally {
    await client.close();
    await deleteDatabase(name);
  }
});

browserTest("reports multiple matches as an ambiguity and never picks one", async ({ browser }) => {
  const name = `ramose-graph-ambiguous-${browser.uniqueId}`;
  const installed = await installClientCatalog(AppSchema);
  await seed(name, [{
    graphPath: [],
    identity: identityFor(opaque("R"), [], installed.readCompatibilityHash),
    datoms: [
      ...graphRow(opaque("e"), ":organization", ":organization/slug", "acme", "acme-org", [
        fact(opaque("e"), ":organization/region", "eu"),
      ]),
      ...graphRow(opaque("h"), ":organization", ":organization/slug", "other", "other-org", [
        fact(opaque("h"), ":organization/region", "eu"),
      ]),
    ],
  }]);
  const client = offlineClient(name);
  try {
    const db = client.open();

    const ambiguous = db.query
      .from(Organization)
      .where({ region: "eu" })
      .orderBy(Organization.slug)
      .limit(1)
      .one()
      .db();
    const boards = ambiguous.observe(
      ambiguous.query.from(Board).select({ slug: Board.slug }),
    );
    const held = boards.subscribe(() => undefined);
    const failed = await waitFor(boards, (snapshot) => snapshot.status === "error");
    expect(failed.error).toBeInstanceOf(GraphPathError);
    expect((failed.error as GraphPathError).reason).toBe("ambiguous");
    expect(failed.data).toBeUndefined();
    held();
  } finally {
    await client.close();
    await deleteDatabase(name);
  }
});

browserTest("reuses child storage only for a path an authenticated response confirmed", async ({ browser }) => {
  const name = `ramose-graph-stable-${browser.uniqueId}`;
  const installed = await installClientCatalog(AppSchema);
  const hash = installed.readCompatibilityHash;

  await seed(name, [
    {
      graphPath: [],
      identity: identityFor(opaque("R"), [], hash),
      datoms: graphRow(opaque("e"), ":organization", ":organization/slug", "acme", "acme-org"),
    },
    {
      graphPath: ["acme-org"],
      identity: identityFor(opaque("O"), ORG_LINEAGE, hash),
      datoms: graphRow(opaque("f"), ":board", ":board/slug", "roadmap", "roadmap-board"),
    },
  ]);
  const client = offlineClient(name);
  try {
    const db = client.open();
    const org = orgHandle(db);
    const boards = org.observe(org.query.from(Board).select({ slug: Board.slug }));
    const held = boards.subscribe(() => undefined);
    expect((await waitFor(boards, (snapshot) => snapshot.status === "ready")).data)
      .toEqual([{ slug: "roadmap" }]);
    held();
  } finally {
    await client.close();
  }

  await deleteDatabase(name);
  await seed(name, [
    {
      graphPath: [],
      identity: identityFor(opaque("R"), [], hash),
      datoms: graphRow(opaque("z"), ":organization", ":organization/slug", "acme", "acme-org"),
    },
    {
      graphPath: ["acme-org"],
      identity: identityFor(opaque("O"), ORG_LINEAGE, hash),
      datoms: graphRow(opaque("f"), ":board", ":board/slug", "roadmap", "roadmap-board"),

      observeRoute: false,
    },
  ]);
  const recreated = offlineClient(name);
  try {
    const db = recreated.open();
    const org = orgHandle(db);
    const boards = org.observe(org.query.from(Board).select({ slug: Board.slug }));
    const held = boards.subscribe(() => undefined);
    await settled(recreated);

    expect(boards.getSnapshot().status).toBe("pending");
    expect(boards.getSnapshot().data).toBeUndefined();
    held();
  } finally {
    await recreated.close();
    await deleteDatabase(name);
  }
});

browserTest("does not read a predecessor Graph's replica through a rotated read view", async ({ browser }) => {
  const name = `ramose-graph-recreate-${browser.uniqueId}`;
  const installed = await installClientCatalog(AppSchema);
  const hash = installed.readCompatibilityHash;

  await seed(name, [
    {
      graphPath: [],
      identity: identityFor(opaque("D"), [], hash, opaque("1")),
      datoms: graphRow(opaque("e"), ":organization", ":organization/slug", "acme", "acme-org"),
      token: "bearer-before",
    },
    {
      graphPath: ["acme-org"],
      identity: identityFor(opaque("C"), ORG_LINEAGE, hash, opaque("1")),
      datoms: graphRow(opaque("f"), ":board", ":board/slug", "roadmap", "roadmap-board"),
      token: "bearer-before",
    },
    {
      graphPath: [],
      identity: identityFor(opaque("D"), [], hash, opaque("2")),
      datoms: graphRow(opaque("z"), ":organization", ":organization/slug", "acme", "acme-org"),
      token: "bearer-after",
    },
  ]);

  const ids = async (
    token: string,
    child: "restores" | "reaches nothing",
  ): Promise<{
    readonly id: string;
    readonly boards: readonly unknown[] | undefined;
  }> => {
    const client = offlineClient(name, { token, cacheKey: CACHE_KEY });
    try {
      const db = client.open();
      const org = db.observe(
        db.query.from(Organization).select({ id: Organization.id }).oneOrFail(),
      );
      const holdOrg = org.subscribe(() => undefined);
      const row = await waitFor(org, (snapshot) => snapshot.status === "ready");
      const handle = orgHandle(db);
      const boards = handle.observe(
        handle.query.from(Board).select({ slug: Board.slug }),
      );
      const holdBoards = boards.subscribe(() => undefined);
      if (child === "restores") {
        await waitFor(boards, (snapshot) => snapshot.status === "ready");
      } else {
        await settled(client);
      }
      holdOrg();
      holdBoards();
      return {
        id: row.data!.id,
        boards: boards.getSnapshot().data as readonly unknown[] | undefined,
      };
    } finally {
      await client.close();
    }
  };

  const before = await ids("bearer-before", "restores");
  const after = await ids("bearer-after", "reaches nothing");
  try {
    expect(before.boards).toEqual([{ slug: "roadmap" }]);
    expect(before.id).toMatch(/^[A-Za-z0-9_-]{54}[AEIMQUYcgkosw048]$/);
    expect(after.id).toMatch(/^[A-Za-z0-9_-]{54}[AEIMQUYcgkosw048]$/);
    expect(after.id).not.toBe(before.id);
    expect(after.boards).toBeUndefined();
  } finally {
    await deleteDatabase(name);
  }
});

browserTest("stops resolving a path whose ancestor authorization was withdrawn", async ({ browser }) => {
  const name = `ramose-graph-revoked-${browser.uniqueId}`;
  await nested(name);
  const installed = await installClientCatalog(AppSchema);
  const storage = await IndexedDbReplicaStorage.open(name);
  try {
    await storage.unbindCredential(await replicationCredentialFingerprint(
      TOKEN,
      replicationActivationAddress({ server: OFFLINE, root: ROOT, graphPath: [] }),
      await rootReplicaRouteSlot(),
    ));
    expect(await storage.restoreBound(
      await replicationCredentialFingerprint(
        TOKEN,
        replicationActivationAddress({
          server: OFFLINE, root: ROOT, graphPath: ["acme-org", "roadmap-board"],
        }),
        await stableReplicaRouteSlot(BOARD_LINEAGE),
      ),
      installed.attributes,
      installed.readCompatibilityHash,
    )).toBeDefined();
  } finally {
    storage.close();
  }

  const client = offlineClient(name);
  try {
    const db = client.open();
    const board = boardHandle(db);
    const open = issues(board);
    const held = open.subscribe(() => undefined);
    await settled(client);

    expect(open.getSnapshot().status).toBe("pending");
    expect(open.getSnapshot().data).toBeUndefined();
    held();
  } finally {
    await client.close();
    await deleteDatabase(name);
  }
});

browserTest("never renders child storage whose read view this build cannot read", async ({ browser }) => {
  const name = `ramose-graph-readview-${browser.uniqueId}`;
  const installed = await installClientCatalog(AppSchema);
  await seed(name, [
    {
      graphPath: [],
      identity: identityFor(opaque("R"), [], installed.readCompatibilityHash),
      datoms: graphRow(opaque("e"), ":organization", ":organization/slug", "acme", "acme-org"),
    },
    {
      graphPath: ["acme-org"],

      identity: identityFor(opaque("O"), ORG_LINEAGE, opaque("w")),
      datoms: graphRow(opaque("f"), ":board", ":board/slug", "roadmap", "roadmap-board"),
    },
  ]);
  const client = offlineClient(name);
  try {
    const db = client.open();
    const org = orgHandle(db);
    const boards = org.observe(org.query.from(Board).select({ slug: Board.slug }));
    const held = boards.subscribe(() => undefined);
    await settled(client);
    expect(boards.getSnapshot().status).toBe("pending");
    expect(boards.getSnapshot().data).toBeUndefined();
    held();
  } finally {
    await client.close();
    await deleteDatabase(name);
  }
});

browserTest("constructs and reconstructs nested handles during rendering for free", async ({ browser }) => {
  const name = `ramose-graph-render-${browser.uniqueId}`;
  await nested(name);
  const client = offlineClient(name);
  try {
    const db = client.open();

    const render = () => issues(boardHandle(db));
    const first = render();
    const held = first.subscribe(() => undefined);
    const ready = await waitFor(first, (snapshot) => snapshot.status === "ready");
    for (let pass = 0; pass < 5; pass++) {
      expect(boardHandle(db)).toBe(boardHandle(db));
      expect(render().getSnapshot()).toBe(ready);
    }
    held();

    expect(render().getSnapshot()).toBe(ready);
  } finally {
    await client.close();
    await deleteDatabase(name);
  }
});
