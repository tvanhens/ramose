/**
 * Graph handles, end to end in a real browser (#477 slice 2).
 *
 * Nothing here is simulated. Real Chromium IndexedDB, the real replica
 * installer, the real credential binding and route-slot selection over
 * WebCrypto, the real `ReplicationSession`, the real query engine — reached only
 * through `createClient`, exactly as an application does.
 *
 * The lane is offline by construction: the origin refuses every connection, so
 * every nested path that resolves here resolved *locally*, ancestor by
 * ancestor, out of replicas a previous authenticated session left behind. That
 * is the claim being tested — a nested path is not a network operation.
 *
 * A "previous session" is spelled here the way one really happens: a snapshot
 * installed through `startSnapshot`/`stageSnapshotChunk`/`commitSnapshot`, and
 * a binding written through `bindAuthenticated` with the route observation that
 * response confirmed. Nothing invents a session, a frame, or an authorization.
 */

import { expect } from "vitest";
import { compileReadAuthorization } from "../../packages/ramose/src/internal/authorization/index.ts";
import { Catalog } from "../../packages/ramose/src/Catalog.ts";
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

// ── the application's catalog ───────────────────────────────────────────────

/** The runnable child catalog a `Graph` entity binds. Never in public input. */
const Child = { key: "child", schema: Schema({}) } satisfies CodeDefinition;

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

const AppSchema = Schema({ organization: Organization, board: Board, issue: Issue });
/** The policy is never run on a client; it stays the unevaluated authored value. */
const AppCatalog = Catalog("client-graph", {
  schema: AppSchema,
  policy: compileReadAuthorization({ schema: AppSchema, rules: [] }),
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

/** Give every pending activation a chance to settle before asserting absence. */
const settled = async (client: Client): Promise<void> => {
  await waitFor(client.sync, (state) =>
    state.status === "offline" || state.status === "closed");
  for (let turn = 0; turn < 40; turn++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 50));
};

// ── seeding one previously authenticated session ───────────────────────────

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
  /** The graph-path names this replica is reached by; `[]` is the root. */
  readonly graphPath: readonly string[];
  readonly identity: ReplicationIdentity;
  readonly datoms: readonly SnapshotDatom[];
  /**
   * Whether that previous session's response also confirmed this path text.
   * Without it an offline client has never observed this path and must reuse
   * nothing, which is the honest behavior and one of the cases tested below.
   */
  readonly observeRoute?: boolean;
  readonly token?: string;
};

const slotFor = (seed: Seed): Promise<ReplicaRouteSlot> =>
  seed.graphPath.length === 0
    ? rootReplicaRouteSlot()
    : stableReplicaRouteSlot(seed.identity.graphLineage);

/** Install and bind replicas exactly as prior authenticated sessions left them. */
const seed = async (name: string, seeds: readonly Seed[]): Promise<void> => {
  const installed = await installClientCatalog(AppCatalog);
  const storage = await IndexedDbReplicaStorage.open(name);
  try {
    for (const entry of seeds) {
      const identity = entry.identity;
      const snapshot = opaque("q");
      const revision = opaque("r");
      await storage.startSnapshot({
        type: "SnapshotStart", protocol: 1, identity, snapshot, revision,
      });
      await storage.stageSnapshotChunk(snapshotChunk({
        type: "SnapshotChunk", protocol: 1, identity, snapshot, index: 0,
        datoms: entry.datoms,
      }));
      const committed = await storage.commitSnapshot({
        type: "SnapshotCommit", protocol: 1, identity, snapshot, revision, chunks: 1,
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

/** One `Graph` row in a parent replica: what a child database is reached by. */
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
    catalog: AppCatalog,
    auth: () => credential,
    storageName: name,
  });

const ORG_LINEAGE = [opaque("1")];
const BOARD_LINEAGE = [opaque("1"), opaque("2")];

/** root → organization "acme" → board "roadmap", as three bound replicas. */
const nested = async (
  name: string,
  options: { readonly boards?: boolean } = {},
): Promise<void> => {
  const installed = await installClientCatalog(AppCatalog);
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

// ── nested activation, offline, out of cached replicas ─────────────────────

browserTest("activates a nested path ancestor by ancestor, offline", async ({ browser }) => {
  const name = `ramose-graph-nested-${browser.uniqueId}`;
  await nested(name);
  const client = offlineClient(name);
  try {
    const db = client.open();
    // Constructing the whole path is inert: no storage was opened by it.
    const board = boardHandle(db);
    expect(client.sync.getSnapshot().status).toBe("idle");

    const open = issues(board);
    expect(open.getSnapshot().status).toBe("pending");
    const held = open.subscribe(() => undefined);

    // Two ancestors resolved and three databases activated, and the origin
    // refuses every connection — so all of it came out of local storage.
    const ready = await waitFor(open, (snapshot) => snapshot.status === "ready");
    expect(ready.data).toEqual([{ title: "offline" }]);
    expect(ready.stale).toBe(true);
    expect(open.getSnapshot()).toBe(ready);
    expect(await waitFor(client.sync, (state) => state.status === "offline"))
      .toBeDefined();

    // The intermediate database is an ordinary database in its own right.
    const boards = orgHandle(db).observe(
      orgHandle(db).query.from(Board).select({ slug: Board.slug }),
    );
    const holdBoards = boards.subscribe(() => undefined);
    expect((await waitFor(boards, (snapshot) => snapshot.status === "ready")).data)
      .toEqual([{ slug: "roadmap" }]);

    // Equivalent paths are one handle, so the descendant observation they share
    // is one observation with one snapshot.
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
  // Only the root was ever confirmed: the organization's own database has no
  // replica, so the board below it has no complete parent to resolve against.
  const installed = await installClientCatalog(AppCatalog);
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

    // The first segment resolved from the root replica; the second cannot,
    // because its parent has no complete local value at all. No partial answer
    // and no error — the honest state is that this path is not readable yet.
    expect(open.getSnapshot().status).toBe("pending");
    expect(open.getSnapshot().data).toBeUndefined();

    // The organization handle itself is in the same state, for the same reason.
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

// ── resolution outcomes ────────────────────────────────────────────────────

browserTest("collapses zero and hidden matches into one opaque unavailable result", async ({ browser }) => {
  const name = `ramose-graph-unavailable-${browser.uniqueId}`;
  await nested(name);
  const client = offlineClient(name);
  try {
    const db = client.open();
    // An organization that does not exist, and one the authorized view never
    // sent. Locally these are the same fact, and they must stay the same fact:
    // a distinguishable "hidden" would disclose what the policy withheld.
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
    // Byte for byte the same answer for both.
    expect((two.getSnapshot().error as GraphPathError).reason)
      .toBe((failed.error as GraphPathError).reason);
    expect(two.getSnapshot().error?.message).toBe(failed.error?.message);
    // Stable identity: reading again is not a change.
    expect(one.getSnapshot()).toBe(failed);
    for (const release of holds) release();
  } finally {
    await client.close();
    await deleteDatabase(name);
  }
});

browserTest("reports multiple matches as an ambiguity and never picks one", async ({ browser }) => {
  const name = `ramose-graph-ambiguous-${browser.uniqueId}`;
  const installed = await installClientCatalog(AppCatalog);
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
    // Two organizations in the same region. Ordering and a limit would make
    // this "resolve" by taking the first, which is exactly what must not
    // happen: dropping them is what turns the second match into an error.
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

// ── stable graph identity, not path text ───────────────────────────────────

browserTest("reuses child storage only for a path an authenticated response confirmed", async ({ browser }) => {
  const name = `ramose-graph-stable-${browser.uniqueId}`;
  const installed = await installClientCatalog(AppCatalog);
  const hash = installed.readCompatibilityHash;
  // The organization replica a previous session left behind is bound at the
  // stable slot its confirmed lineage derives, and the root replica names the
  // Graph entity that lineage belongs to.
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

  // Now the same path *text*, for a Graph entity this client has never
  // confirmed — what a delete/recreate of a same-named Graph looks like from
  // here, since the recreated entity's lineage is a new one and no response has
  // ever named it. Identical path text reuses nothing.
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
      // The recreated Graph's path has never been confirmed under its new
      // lineage, so this client has observed no route for it.
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
    // The same name, and nothing behind it: an unconfirmed path reuses no
    // storage, so a recreated Graph cannot inherit its predecessor's replica.
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
  const installed = await installClientCatalog(AppCatalog);
  const hash = installed.readCompatibilityHash;
  // One database, two read views — what a delete/recreate of a Graph inside it
  // leaves behind. The predecessor's Graph row and the successor's are
  // different entities, and each view numbers its own visible entities from
  // scratch, so the successor lands on the predecessor's *local* id. That
  // collision is the whole hazard, and the stable key must survive it while
  // *not* separating the two read views — a benign rotation has to keep the
  // child's replica. It does both because the key is the database scope plus
  // the sealed `EntityId`: the scope is identical across the two views, and
  // the two Graph entities seal different eids, so the collision that a
  // partition-local id would have produced cannot arise (#477).
  await seed(name, [
    {
      graphPath: [],
      identity: identityFor(opaque("D"), [], hash, opaque("1")),
      datoms: graphRow(opaque("e"), ":organization", ":organization/slug", "acme", "acme-org"),
      token: "bearer-before",
    },
    {
      // The predecessor's child database, complete and bound, with the route
      // its own authenticated session confirmed.
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

  /**
   * Read one session's organization id and whatever its board query renders.
   *
   * `child` names the settled condition this session is driven to, and the two
   * are genuinely different waits. `settled` can only report the *aggregate*
   * `client.sync`, where `offline` outranks `connecting` — so the root's
   * refused connection alone satisfies it, while the child activation behind
   * `orgHandle` is still restoring its replica out of IndexedDB. That is fine
   * for a session with no child to reach, and it is not a wait at all for the
   * one that has: the predecessor is driven to the child's own `ready` instead,
   * on `waitFor`'s bounded deadline, exactly as every other positive read in
   * this file is.
   */
  const ids = async (
    token: string,
    child: "restores" | "reaches nothing",
  ): Promise<{
    readonly id: number;
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
        id: (row.data as { readonly id: number }).id,
        boards: boards.getSnapshot().data as readonly unknown[] | undefined,
      };
    } finally {
      await client.close();
    }
  };

  const before = await ids("bearer-before", "restores");
  const after = await ids("bearer-after", "reaches nothing");
  try {
    // The predecessor reads its own child database — the positive control, so
    // the successor's silence below is a decision and not an empty fixture.
    expect(before.boards).toEqual([{ slug: "roadmap" }]);
    // The collision is real: two different Graph entities, one local id.
    expect(after.id).toBe(before.id);
    // And the successor reads nothing of the predecessor's. It is a different
    // Graph entity, so it seals a different handle and is a different stable
    // identity, with no activation and no confirmed lineage to inherit — even
    // though the two read views share one scope and one local id.
    expect(after.boards).toBeUndefined();
  } finally {
    await deleteDatabase(name);
  }
});

// ── fencing the path, not just the storage ─────────────────────────────────

browserTest("stops resolving a path whose ancestor authorization was withdrawn", async ({ browser }) => {
  const name = `ramose-graph-revoked-${browser.uniqueId}`;
  await nested(name);
  const installed = await installClientCatalog(AppCatalog);
  const storage = await IndexedDbReplicaStorage.open(name);
  try {
    // What the session does when the server refuses this exact credential for
    // the root: the ancestor's binding is withdrawn. The child replicas are
    // untouched — same stable identity, still bound, still complete.
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
    // Retained child storage with the same stable identity is not a path: the
    // authorization the path needed came from the ancestor, and it is gone.
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
  const installed = await installClientCatalog(AppCatalog);
  await seed(name, [
    {
      graphPath: [],
      identity: identityFor(opaque("R"), [], installed.readCompatibilityHash),
      datoms: graphRow(opaque("e"), ":organization", ":organization/slug", "acme", "acme-org"),
    },
    {
      graphPath: ["acme-org"],
      // The very same stable graph identity — and a read view this build cannot
      // read. Retained storage is not permission to render it.
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

// ── construction during rendering ──────────────────────────────────────────

browserTest("constructs and reconstructs nested handles during rendering for free", async ({ browser }) => {
  const name = `ramose-graph-render-${browser.uniqueId}`;
  await nested(name);
  const client = offlineClient(name);
  try {
    const db = client.open();
    // A render loop: the whole path is rebuilt on every pass, and every pass
    // must produce the same handle, the same observation, and the same
    // snapshot — otherwise a component would resubscribe forever.
    const render = () => issues(boardHandle(db));
    const first = render();
    const held = first.subscribe(() => undefined);
    const ready = await waitFor(first, (snapshot) => snapshot.status === "ready");
    for (let pass = 0; pass < 5; pass++) {
      expect(boardHandle(db)).toBe(boardHandle(db));
      expect(render().getSnapshot()).toBe(ready);
    }
    held();
    // Releasing the last listener is not a change: the path still answers with
    // what it was showing, from the very same snapshot value.
    expect(render().getSnapshot()).toBe(ready);
  } finally {
    await client.close();
    await deleteDatabase(name);
  }
});
