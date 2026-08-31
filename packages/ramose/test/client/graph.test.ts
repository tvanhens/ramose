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
import { sealedHandle } from "../replication-fixtures.ts";

const BoardCatalog = { key: "board", schema: Schema({}) } satisfies CodeDefinition;

const Organization = Entity("organization", {
  slug: Field.unique(string(), "strict"),
  region: string(),
}, { traits: [Graph(BoardCatalog)] });

const Board = Entity("board", {
  slug: Field.unique(string(), "strict"),
}, { traits: [Graph(BoardCatalog)] });

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

    expect("db" in org).toBe(false);
    expect(typeof (org.one() as { db?: unknown }).db).toBe("function");
    expect(typeof (org.oneOrFail() as { db?: unknown }).db).toBe("function");

    const member = db.query.from(Member).where({ handle: "ada" });
    expect("db" in member.one()).toBe(false);
    expect("db" in member.oneOrFail()).toBe(false);

    // @ts-expect-error
    member.one().db;
  });

  test("is inert, synchronous, and interned by parent plus canonical query", () => {
    const db = root();
    const path = () => db.query.from(Organization).where({ slug: "acme" }).one().db();

    expect(path()).toBe(path());

    expect(db.sync.getSnapshot().status).toBe("idle");

    const other = db.query.from(Organization).where({ slug: "other" }).one().db();
    expect(other).not.toBe(path());

    expect(db.query.from(Board).where({ slug: "acme" }).one().db()).not.toBe(path());
  });

  test("interns nested paths one segment at a time", () => {
    const db = root();
    const org = () => db.query.from(Organization).where({ slug: "acme" }).one().db();
    const board = (parent: ClientDatabase) =>
      parent.query.from(Board).where({ slug: "roadmap" }).one().db();
    expect(board(org())).toBe(board(org()));

    const elsewhere = db.query.from(Organization).where({ slug: "other" }).one().db();
    expect(board(elsewhere)).not.toBe(board(org()));
  });

  test("canonicalizes away everything that does not decide which entity is named", () => {
    const db = root();
    const canonical = db.query.from(Organization).where({ slug: "acme" }).one().db();

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

    expect(db.query.from(Organization).where({ slug: "acme" }).oneOrFail().db())
      .toBe(canonical);

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

    expect(query.limit).toBe(2);
  });
});

describe("the canonical resolution query", () => {
  const logic = () =>

    (client().open().query.from(Organization).where({ slug: "acme" }) as never);

  test("asks for exactly one entity, its local id, and its canonical name", () => {
    const lowered = lowerQueryObject(graphResolutionQuery(logic(), Organization));
    const query = lowered.query as {
      readonly find: readonly unknown[];
      readonly limit?: number;
    };

    expect(query.limit).toBe(2);
    const text = JSON.stringify(lowered.query);
    expect(text).toContain(":graph/name");
    expect(text).toContain(":organization/slug");

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
    mutations: {
      databaseOperations: () => new Map(),
      selfOperations: () => new Map(),
      catalog: () => Promise.reject(new Error("not activated")),
      storage: () => Promise.reject(new Error("not activated")),
      assertLive: () => undefined,
      submit: () => undefined,
      track: () => undefined,
    },
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

  const path = (): object => ({});

  test("reuses one database per stable identity and re-authorizes a rename", () => {
    const stable = "parent-database eid-1000";
    const holder = path();
    const first = registry.acquire(stable, ["acme"], holder);

    expect(registry.acquire(stable, ["acme"], holder)).toBe(first);

    expect(lineages).toEqual([undefined]);

    confirmations.get(first)!(confirmed([opaque("1")]));

    const renamed = registry.acquire(stable, ["acme-renamed"], holder);
    expect(renamed).not.toBe(first);
    expect(lineages[1]).toEqual([opaque("1")]);
    expect(renamed.graphPath()).toEqual(["acme-renamed"]);

    const recreated = registry.acquire(
      "parent-database eid-1001",
      ["acme-renamed"],
      path(),
    );
    expect(recreated).not.toBe(renamed);
    expect(lineages[2]).toBeUndefined();

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

    const [one, two] = [path(), path()];
    const database = local.acquire("stable", ["acme"], one);
    expect(local.acquire("stable", ["acme"], two)).toBe(database);

    expect(changes).toHaveLength(1);
    local.retire("stable", one);
    expect(local.handles()).toHaveLength(1);
    expect(changes).toHaveLength(1);
    expect(local.acquire("stable", ["acme"], one)).toBe(database);

    local.retire("stable", one);
    local.retire("stable", two);
    expect(local.handles()).toHaveLength(0);

    expect(changes).toHaveLength(2);

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

    local.acquire("stable", ["acme-renamed"], holder);
    expect(seen[1]).toEqual([opaque("1")]);

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

  const handle = (character: string): string => sealedHandle(opaque(character));

  test("survives a benign read-view rotation of one database", () => {
    const before = replicaDatabaseScopeOf(view("1"));
    const after = replicaDatabaseScopeOf(view("2"));

    expect(replicaDatabaseKey(before)).toBe(replicaDatabaseKey(after));

    expect(graphStableKey(before, handle("g")))
      .toBe(graphStableKey(after, handle("g")));
  });

  test("separates a deleted and recreated Graph, and two databases", () => {
    const scope = replicaDatabaseScopeOf(view("1"));

    expect(graphStableKey(scope, handle("g")))
      .not.toBe(graphStableKey(scope, handle("h")));

    const elsewhere = replicaDatabaseScopeOf({
      ...view("1"),
      database: opaque("e"),
    });
    expect(graphStableKey(scope, handle("g")))
      .not.toBe(graphStableKey(elsewhere, handle("g")));
  });
});

describe("an ancestor's terminal state", () => {
  test("becomes the path failure a descendant query surfaces", () => {
    expect(terminalPathError("authentication-required")?.reason).toBe("unauthorized");
    expect(terminalPathError("update-required")?.reason).toBe("update-required");
    expect(terminalPathError("closed")?.reason).toBe("closed");

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
    expect(fencedReceiver("authentication-required")?.reason).toBe("unauthorized");
    expect(fencedReceiver("update-required")?.reason).toBe("update-required");
    expect(fencedReceiver("closed")?.reason).toBe("closed");

    for (const status of ["idle", "connecting", "live", "stale", "offline"] as const) {
      expect(fencedReceiver(status)).toBeUndefined();
    }
  });
});
