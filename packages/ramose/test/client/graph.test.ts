/**
 * Graph-handle construction, canonicalization, and interning (#477 slice 2).
 *
 * Everything here is what `.one().db()` does *before* anything is observed, and
 * that is the whole point: construction is inert, so it is ordinary input-value
 * logic and belongs in the pure lane. No storage, no session, no network —
 * `createClient` opens nothing until a query is observed, so a client is a
 * legitimate pure-test subject right up to that line.
 */

import { describe, expect, test } from "bun:test";
import { Catalog } from "../../src/Catalog.ts";
import { compileReadAuthorization } from "../../src/internal/authorization/index.ts";
import {
  Entity,
  Field,
  Graph,
  Schema,
  lowerQueryObject,
  string,
  type CodeDefinition,
} from "../../src/db/internal.ts";
import { offset as offsetStage } from "../../src/db/query/lib.ts";
import { createClient } from "../../src/client/index.ts";
import {
  fencedReceiver,
  graphResolutionQuery,
  GraphRegistry,
  graphStableKey,
  resolveGraphReceiver,
  terminalPathError,
} from "../../src/client/graph.ts";
import {
  replicaDatabaseKey,
  replicaDatabaseScopeOf,
} from "../../src/internal/replication/replica-lifecycle.ts";
import {
  ClientDatabaseHandle,
  queryObservationKey,
  type DatabaseContext,
} from "../../src/client/database.ts";
import type { ClientDatabase } from "../../src/client/index.ts";
import type { ReplicationIdentity } from "../../src/internal/replication/protocol.ts";

const BoardCatalog = { key: "board", schema: Schema({}) } satisfies CodeDefinition;

const Organization = Entity("organization", {
  slug: Field.unique(string(), "strict"),
  region: string(),
}, { traits: [Graph(BoardCatalog)] });

const Board = Entity("board", {
  slug: Field.unique(string(), "strict"),
}, { traits: [Graph(BoardCatalog)] });

/** No `Graph` trait: an ordinary entity is not the root of a database. */
const Member = Entity("member", { handle: Field.unique(string(), "strict") });

const AppSchema = Schema({ organization: Organization, board: Board, member: Member });
const AppCatalog = Catalog("client-graph", {
  schema: AppSchema,
  policy: compileReadAuthorization({ schema: AppSchema, rules: [] }),
});

const client = () =>
  createClient({
    url: "https://data.example.com",
    root: "app",
    catalog: AppCatalog,
    auth: () => ({ token: "bearer", cacheKey: "account" }),
    storageName: "ramose-graph-pure-never-opened",
  });

const root = (): ClientDatabase => client().open();

describe("graph handle construction", () => {
  test("is available only on an exactly-one focus carrying the Graph trait", () => {
    const db = root();
    const org = db.query.from(Organization).where({ slug: "acme" });
    // Not a terminal: a query that can answer with many rows names no database.
    expect("db" in org).toBe(false);
    expect(typeof (org.one() as { db?: unknown }).db).toBe("function");
    expect(typeof (org.oneOrFail() as { db?: unknown }).db).toBe("function");

    // The deployed schema decides, statically: an entity with no `Graph` trait
    // has no `.db()` at all, at either terminal.
    const member = db.query.from(Member).where({ handle: "ada" });
    expect("db" in member.one()).toBe(false);
    expect("db" in member.oneOrFail()).toBe(false);

    // @ts-expect-error — and the type says so too.
    member.one().db;
  });

  test("is inert, synchronous, and interned by parent plus canonical query", () => {
    const db = root();
    const path = () => db.query.from(Organization).where({ slug: "acme" }).one().db();
    // Constructing the same path twice — the render loop's normal case — is one
    // handle, so a component that builds it on every render retains nothing new.
    expect(path()).toBe(path());
    // Nothing was activated by any of it.
    expect(db.sync.getSnapshot().status).toBe("idle");

    const other = db.query.from(Organization).where({ slug: "other" }).one().db();
    expect(other).not.toBe(path());
    // A different entity at the same name is a different path.
    expect(db.query.from(Board).where({ slug: "acme" }).one().db()).not.toBe(path());
  });

  test("interns nested paths one segment at a time", () => {
    const db = root();
    const org = () => db.query.from(Organization).where({ slug: "acme" }).one().db();
    const board = (parent: ClientDatabase) =>
      parent.query.from(Board).where({ slug: "roadmap" }).one().db();
    expect(board(org())).toBe(board(org()));
    // The same child query under a different parent is a different path: a
    // graph identity is chained, never global.
    const elsewhere = db.query.from(Organization).where({ slug: "other" }).one().db();
    expect(board(elsewhere)).not.toBe(board(org()));
  });

  test("canonicalizes away everything that does not decide which entity is named", () => {
    const db = root();
    const canonical = db.query.from(Organization).where({ slug: "acme" }).one().db();
    // Equality filters are order-independent…
    expect(
      db.query
        .from(Organization)
        .where({ region: "eu" })
        .where({ slug: "acme" })
        .one()
        .db(),
    ).toBe(
      db.query
        .from(Organization)
        .where({ slug: "acme" })
        .where({ region: "eu" })
        .one()
        .db(),
    );
    // …and `one()` / `oneOrFail()` name the same path: both mean one entity,
    // and the resolution outcomes are the frozen ones either way.
    expect(db.query.from(Organization).where({ slug: "acme" }).oneOrFail().db())
      .toBe(canonical);
    // Ordering and paging shape *how* matches are returned, never *which*
    // entities match — and resolving two matches by taking the first is exactly
    // the arbitrary selection the frozen semantics forbid.
    expect(
      db.query
        .from(Organization)
        .where({ slug: "acme" })
        .orderBy(Organization.region)
        .limit(1)
        .one()
        .db(),
    ).toBe(canonical);
    expect(
      db.query.from(Organization).where({ slug: "acme" }).ids().one().db(),
    ).toBe(canonical);
  });

  test("drops a cursor stage smuggled through where(...)", () => {
    const db = root();
    // `where` takes arbitrary same-focus stages, so the pipeline is a second
    // way in for a cursor. `oneOrFail` overrides a stray `limit`, but an
    // `offset` would survive and hand back the *second* of two matches as
    // though it were the only one — the arbitrary selection the frozen
    // semantics forbid, and durable once a mutation is queued against it.
    const smuggled = db.query
      .from(Organization)
      .where({ slug: "acme" })
      .where(offsetStage(1) as never);
    expect(smuggled.one().db()).toBe(
      db.query.from(Organization).where({ slug: "acme" }).one().db(),
    );
    const lowered = lowerQueryObject(
      graphResolutionQuery(smuggled as never, Organization),
    );
    const query = lowered.query as {
      readonly limit?: number;
      readonly offset?: number;
      readonly order?: unknown;
    };
    expect(query.offset).toBeUndefined();
    expect(query.order).toBeUndefined();
    // And the `oneOrFail` limit still stands, so a second match is witnessed.
    expect(query.limit).toBe(2);
  });
});

describe("the canonical resolution query", () => {
  const logic = () =>
    // The same value `.db()` canonicalizes from: membership and `where`, and
    // nothing else.
    (client().open().query.from(Organization).where({ slug: "acme" }) as never);

  test("asks for exactly one entity, its local id, and its canonical name", () => {
    const lowered = lowerQueryObject(graphResolutionQuery(logic(), Organization));
    const query = lowered.query as {
      readonly find: readonly unknown[];
      readonly limit?: number;
    };
    // `oneOrFail` lowering forces `limit 2`, which is what witnesses a second
    // match without pulling a page — an ambiguity has to be *seen* to be
    // reported rather than silently resolved.
    expect(query.limit).toBe(2);
    const text = JSON.stringify(lowered.query);
    expect(text).toContain(":graph/name");
    expect(text).toContain(":organization/slug");
    // The path segment activation sends is the current `:graph/name`, so the
    // resolution has to read it rather than reuse the text of the query.
    expect(text).not.toContain("acme-renamed");
  });

  test("gives two spellings of one path the same interned identity", () => {
    const one = queryObservationKey(graphResolutionQuery(logic(), Organization));
    const two = queryObservationKey(graphResolutionQuery(logic(), Organization));
    expect(one).toBe(two);
    const elsewhere = queryObservationKey(
      graphResolutionQuery(
        client().open().query.from(Organization).where({ slug: "other" }) as never,
        Organization,
      ),
    );
    expect(elsewhere).not.toBe(one);
  });
});

describe("the resolved-database registry", () => {
  const opaque = (character: string): string => character.repeat(43);

  /**
   * One database handle over a context nothing in these tests activates: the
   * subject is which handle the registry hands back and what lineage it hands
   * it, and neither touches storage, credentials, or a session.
   */
  const context = (
    graphPath: readonly string[],
    graphLineage: () => readonly string[] | undefined,
  ): DatabaseContext => ({
    server: "https://data.example.com",
    root: "app",
    graphPath,
    graphLineage,
    graph: () => registry,
    catalog: () => Promise.reject(new Error("not activated")),
    storage: () => Promise.reject(new Error("not activated")),
    credential: () => Promise.reject(new Error("not activated")),
    assertLive: () => undefined,
    live: () => true,
    onSyncChange: () => undefined,
    onConfirmed: () => undefined,
    onFenced: () => undefined,
  });

  const lineages: (readonly string[] | undefined)[] = [];
  const registry: GraphRegistry = new GraphRegistry(
    ({ graphPath, graphLineage, onConfirmed }) => {
      const handle = new ClientDatabaseHandle(context(graphPath, graphLineage));
      confirmations.set(handle, onConfirmed);
      lineages.push(graphLineage());
      return handle;
    },
    () => undefined,
  );
  const confirmations = new Map<
    ClientDatabaseHandle,
    (identity: ReplicationIdentity) => void
  >();

  const confirmed = (lineage: readonly string[]): ReplicationIdentity => ({
    version: 1,
    server: opaque("s"),
    principal: opaque("p"),
    database: opaque("d"),
    catalog: opaque("c"),
    readView: opaque("v"),
    readCompatibilityHash: opaque("h") as ReplicationIdentity["readCompatibilityHash"],
    graphLineage: lineage,
    authenticator: opaque("a"),
  });

  /** Two paths that resolve to one database are two of these. */
  const path = (): object => ({});

  test("reuses one database per stable identity and re-authorizes a rename", () => {
    const stable = "parent-database eid-1000";
    const holder = path();
    const first = registry.acquire(stable, ["acme"], holder);
    // The same stable identity under the same name is the same activation.
    expect(registry.acquire(stable, ["acme"], holder)).toBe(first);
    // Nothing has confirmed a lineage yet, so nothing is pre-selected and the
    // session falls back on the durable observation table by itself.
    expect(lineages).toEqual([undefined]);

    confirmations.get(first)!(confirmed([opaque("1")]));

    // Renamed. The path authorization was for a name that no longer exists, so
    // a new activation opens — carrying the lineage the previous one confirmed,
    // which is what selects the very same durable replica and resumes it
    // instead of taking a fresh snapshot.
    const renamed = registry.acquire(stable, ["acme-renamed"], holder);
    expect(renamed).not.toBe(first);
    expect(lineages[1]).toEqual([opaque("1")]);
    expect(renamed.graphPath()).toEqual(["acme-renamed"]);

    // A different Graph entity — a delete/recreate under the same name — is a
    // different stable identity, so it inherits nothing.
    const recreated = registry.acquire(
      "parent-database eid-1001",
      ["acme-renamed"],
      path(),
    );
    expect(recreated).not.toBe(renamed);
    expect(lineages[2]).toBeUndefined();

    // A lineage that does not describe every segment of the path it is offered
    // for cannot select a slot for it, and is withheld rather than guessed.
    const deep = path();
    const deeper = registry.acquire("parent-database eid-1002", ["acme", "board"], deep);
    confirmations.get(deeper)!(confirmed([opaque("1")]));
    registry.acquire("parent-database eid-1002", ["acme", "board-renamed"], deep);
    expect(lineages[4]).toBeUndefined();
  });

  test("closes a database only when the last path naming it lets go", async () => {
    const changes: number[] = [];
    const local = new GraphRegistry(
      ({ graphPath, graphLineage }) =>
        new ClientDatabaseHandle(context(graphPath, graphLineage)),
      () => changes.push(changes.length),
    );
    // Two queries that select the same Graph entity are two paths and one
    // activation. One of them turning ambiguous, or losing its ancestor, must
    // not take the database out from under the other.
    const [one, two] = [path(), path()];
    const database = local.acquire("stable", ["acme"], one);
    expect(local.acquire("stable", ["acme"], two)).toBe(database);
    // Joining an existing database is not a membership change.
    expect(changes).toHaveLength(1);
    local.retire("stable", one);
    expect(local.statuses()).toHaveLength(1);
    expect(changes).toHaveLength(1);
    expect(local.acquire("stable", ["acme"], one)).toBe(database);

    local.retire("stable", one);
    local.retire("stable", two);
    expect(local.statuses()).toHaveLength(0);
    // The client's aggregate is over the databases it *has*, and a closing
    // handle publishes only to its own store — so losing one has to drive the
    // recomputation itself, or `client.sync` would go on reporting a database
    // that is gone.
    expect(changes).toHaveLength(2);
    // Retiring what is no longer there is not an error, and is not a change.
    local.retire("stable", two);
    expect(changes).toHaveLength(2);
    await local.close();
  });

  test("forgets a retired database's lineage rather than lending it on", () => {
    const seen: (readonly string[] | undefined)[] = [];
    const confirm = new Map<
      ClientDatabaseHandle,
      (identity: ReplicationIdentity) => void
    >();
    const local = new GraphRegistry(
      ({ graphPath, graphLineage, onConfirmed }) => {
        const handle = new ClientDatabaseHandle(context(graphPath, graphLineage));
        confirm.set(handle, onConfirmed);
        seen.push(graphLineage());
        return handle;
      },
      () => undefined,
    );
    const holder = path();
    const first = local.acquire("stable", ["acme"], holder);
    confirm.get(first)!(confirmed([opaque("1")]));

    // A rename keeps the database and its memo: the next activation of the same
    // stable identity resumes onto the replica this one confirmed.
    local.acquire("stable", ["acme-renamed"], holder);
    expect(seen[1]).toEqual([opaque("1")]);

    // Retiring it takes the lineage with it. A memo that outlives what it
    // describes would be a pre-flight selection lent to whatever later reaches
    // this key — including, before the partition-scoped key, a recreated Graph
    // that collided with its predecessor's id.
    local.retire("stable", holder);
    local.acquire("stable", ["acme-renamed"], path());
    expect(seen[2]).toBeUndefined();
  });
});

describe("the stable graph identity", () => {
  const opaque = (character: string): string => character.repeat(43);

  const view = (readView: string): ReplicationIdentity => ({
    version: 1,
    server: opaque("s"),
    principal: opaque("p"),
    database: opaque("d"),
    catalog: opaque("c"),
    readView: opaque(readView),
    readCompatibilityHash: opaque("h") as ReplicationIdentity["readCompatibilityHash"],
    graphLineage: [],
    authenticator: opaque("a"),
  });

  test("separates two read views of one database", () => {
    const before = view("1");
    const after = view("2");
    // The premise: these are the same database, so everything scope-shaped
    // about them is identical…
    expect(replicaDatabaseKey(replicaDatabaseScopeOf(before)))
      .toBe(replicaDatabaseKey(replicaDatabaseScopeOf(after)));
    // …but a local entity id is assigned per *partition*, and a read view is
    // part of a partition. Delete a Graph, recreate a same-named one, and the
    // successor can land on the predecessor's id in the rotated view. Keyed on
    // the scope those two produce one byte-identical key, which would hand the
    // successor the predecessor's live activation and its confirmed lineage —
    // and that lineage restores the predecessor's child replica offline.
    expect(graphStableKey(before, 1000)).not.toBe(graphStableKey(after, 1000));
    // Within one partition an id is still an identity, and two of them differ.
    expect(graphStableKey(before, 1000)).toBe(graphStableKey(view("1"), 1000));
    expect(graphStableKey(before, 1000)).not.toBe(graphStableKey(before, 1001));
  });
});

describe("an ancestor's terminal state", () => {
  test("becomes the path failure a descendant query surfaces", () => {
    // A revoked ancestor and a replaced principal are one status here, and one
    // path failure: the authorization the path needed is invalid either way.
    expect(terminalPathError("authentication-required")?.reason).toBe("unauthorized");
    expect(terminalPathError("update-required")?.reason).toBe("update-required");
    expect(terminalPathError("closed")?.reason).toBe("closed");
    // Everything else is a wait, not a verdict: a path whose ancestor is merely
    // offline or still connecting has not failed, it has not answered yet.
    for (const status of ["idle", "connecting", "live", "stale", "offline"] as const) {
      expect(terminalPathError(status)).toBeUndefined();
    }
  });
});

describe("the mutation pre-queue gate", () => {
  test("refuses a receiver that is not a database this client opened", async () => {
    await expect(resolveGraphReceiver({} as ClientDatabase)).rejects.toMatchObject({
      _tag: "GraphReceiverError",
      reason: "unresolved",
    });
  });

  test("refuses a fenced database before its retained identity can address work", () => {
    // A session that restored a confirmed replica and was then refused keeps
    // its prior identity while it fences the rows — deliberately, so a
    // reconnect recognizes the same partition. Reading it here would durably
    // queue work against a database the credential no longer opens, and a
    // queued invocation and its receipts survive restarts.
    expect(fencedReceiver("authentication-required")?.reason).toBe("unauthorized");
    expect(fencedReceiver("update-required")?.reason).toBe("update-required");
    expect(fencedReceiver("closed")?.reason).toBe("closed");
    // Everything else is a wait: an unreachable server is not a refusal, and a
    // restored replica offline has exactly the identity to queue against.
    for (const status of ["idle", "connecting", "live", "stale", "offline"] as const) {
      expect(fencedReceiver(status)).toBeUndefined();
    }
  });
});
