import { describe, expect, test } from "bun:test";
import {
  CatalogId,
  CatalogUnitHash,
  DatabaseId,
  ReadCompatibilityHash,
  type AuthenticatedCaller,
  type GraphPathLeaseIdentity,
} from "../../../src/internal/authorization/index.ts";
import {
  entityIdScopeOf,
  makeEntityIdentity,
  makeEntityIdScope,
  makeReplicationIdentity,
  makeRevision,
  openEntityId,
  sealEntityId,
  type ServerSealingKey,
} from "../../../src/internal/replication/index.ts";
import { replicaPartitionKey } from "../../../src/internal/replication/indexeddb.ts";

const sealing: ServerSealingKey = {
  keyId: "aaaaaaaaaaaaaaaaaaaaaa",
  material: "replication-test-sealing-root-material------",
};
const digest = (character: string) => character.repeat(64);
const compatibility = (character: string) => ReadCompatibilityHash.make(character.repeat(43));
const caller = (exp: number, org = "acme", sub = "user-1"): AuthenticatedCaller => ({
  exp,
  claims: { sub, org },
  classes: ["member"],
});
const path = (
  database = "child-db",
  catalog = "issues",
  unit = digest("a"),
): GraphPathLeaseIdentity => ({
  rootDatabase: DatabaseId.make("root-db"),
  path: ["organizations", "acme"],
  routes: [
    {
      database: DatabaseId.make("root-db"),
      catalogKey: CatalogId.make("root"),
      unitHash: CatalogUnitHash.make(digest("b")),
    },
    {
      database: DatabaseId.make(database),
      catalogKey: CatalogId.make(catalog),
      unitHash: CatalogUnitHash.make(unit),
    },
  ],
  dependencies: [{ parentDatabase: DatabaseId.make("root-db"), graphEntity: 42 }],
});

const nested = (
  first = 42,
  second = 43,
): GraphPathLeaseIdentity => ({
  ...path(),
  path: ["organizations", "acme", "boards", "roadmap"],
  dependencies: [
    { parentDatabase: DatabaseId.make("root-db"), graphEntity: first },
    { parentDatabase: DatabaseId.make("child-db"), graphEntity: second },
  ],
});

const make = (options: {
  caller?: AuthenticatedCaller;
  path?: GraphPathLeaseIdentity;
  compatibility?: ReadCompatibilityHash;
  policy?: string;
} = {}) => makeReplicationIdentity({
  sealing,
  origin: "https://ramose.test",
  caller: options.caller ?? caller(2_000_000_000),
  path: options.path ?? path(),
  readRoutes: [{
    database: DatabaseId.make("child-db"),
    readCompatibilityHash: options.compatibility ?? compatibility("r"),
    readPolicy: options.policy ?? digest("f"),
  }],
});

describe("opaque replication identities", () => {
  test("ordinary token refresh is stable", async () => {
    expect(await make({ caller: caller(2_000_000_000) }))
      .toEqual(await make({ caller: caller(2_100_000_000) }));
  });

  test("principal, claim view, catalog, database, read schema, and policy partition", async () => {
    const baseline = await make();
    const changed = [
      await make({ caller: caller(2_000_000_000, "other") }),
      await make({ caller: caller(2_000_000_000, "acme", "user-2") }),
      await make({
        caller: {
          ...caller(2_000_000_000),
          classes: ["admin"],
        },
      }),
      await make({ path: path("other-db") }),
      await make({ path: path("child-db", "other-catalog") }),
      await make({ compatibility: compatibility("x") }),
      await make({ policy: digest("e") }),
    ];
    for (const replacement of changed) {
      expect(replacement.authenticator).not.toBe(baseline.authenticator);
      expect(replacement.readView === baseline.readView &&
        replacement.principal === baseline.principal &&
        replacement.database === baseline.database &&
        replacement.catalog === baseline.catalog).toBe(false);
    }
  });

  test("operation-unit and deployment-only changes preserve reusable read identity", async () => {
    const baseline = await make({ path: path("child-db", "issues", digest("a")) });
    const operationOnly = await make({ path: path("child-db", "issues", digest("c")) });
    expect(operationOnly).toEqual(baseline);
    expect(replicaPartitionKey(operationOnly)).toBe(replicaPartitionKey(baseline));
    expect(await makeEntityIdentity(sealing, operationOnly.authenticator, 42)).toBe(
      await makeEntityIdentity(sealing, baseline.authenticator, 42),
    );
    expect(await makeRevision(sealing, operationOnly, "S".repeat(43))).toBe(
      await makeRevision(sealing, baseline, "S".repeat(43)),
    );
    const catalogOnly = await make({ path: path("child-db", "other-catalog", digest("c")) });
    expect(catalogOnly.readView).toBe(baseline.readView);
    expect(catalogOnly.catalog).not.toBe(baseline.catalog);
  });

  test("graph lineage is one ordered opaque element per authorized segment", async () => {
    const root = await make({
      path: { ...path(), path: [], dependencies: [] },
    });
    expect(root.graphLineage).toEqual([]);

    const baseline = await make({ path: nested() });
    expect(baseline.graphLineage).toHaveLength(2);
    for (const entity of baseline.graphLineage) {
      expect(entity).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(entity).not.toContain("42");
      expect(entity).not.toContain("root-db");
      expect(entity).not.toContain("acme");
    }
    expect(new Set(baseline.graphLineage).size).toBe(2);

    // Path text never reaches the lineage; the entities do.
    expect((await make({
      path: { ...nested(), path: ["organizations", "renamed", "boards", "renamed"] },
    })).graphLineage).toEqual(baseline.graphLineage);
    const recreated = await make({ path: nested(42, 99) });
    expect(recreated.graphLineage[0]).toBe(baseline.graphLineage[0]);
    expect(recreated.graphLineage[1]).not.toBe(baseline.graphLineage[1]);
    // Chaining means the same leaf entity under another parent is another value.
    expect((await make({ path: nested(98, 43) })).graphLineage[1])
      .not.toBe(baseline.graphLineage[1]);
    expect((await make({ path: nested(98, 43) })).graphLineage[0])
      .not.toBe(baseline.graphLineage[0]);
    // A different sealing root produces unrelated lineage values.
    expect((await makeReplicationIdentity({
      sealing: {
        keyId: "bbbbbbbbbbbbbbbbbbbbbb",
        material: "another-replication-sealing-root-material---",
      },
      origin: "https://ramose.test",
      caller: caller(2_000_000_000),
      path: nested(),
      readRoutes: [{
        database: DatabaseId.make("child-db"),
        readCompatibilityHash: compatibility("r"),
        readPolicy: digest("f"),
      }],
    })).graphLineage).not.toEqual(baseline.graphLineage);
  });

  test("the sealed entity-id scope is exactly the stable server/principal/database", async () => {
    const identity = await make();
    expect(entityIdScopeOf(identity)).toEqual(
      await makeEntityIdScope(sealing, {
        origin: "https://ramose.test",
        caller: caller(2_000_000_000),
        database: DatabaseId.make("child-db"),
      }),
    );
    // The #475 contract: a compatible read-view, catalog, deployment, or token
    // refresh preserves a queued target; a different database does not.
    const token = await sealEntityId(sealing, entityIdScopeOf(identity), 42);
    const redeployed = await make({
      caller: caller(2_100_000_000),
      path: path("child-db", "other-catalog", digest("c")),
      compatibility: compatibility("x"),
      policy: digest("e"),
    });
    expect(await openEntityId(sealing, entityIdScopeOf(redeployed), token))
      .toEqual({
        type: "resolved",
        eid: 42,
        scope: entityIdScopeOf(redeployed),
      });
    const elsewhere = await make({ path: path("other-db") });
    expect(await openEntityId(sealing, entityIdScopeOf(elsewhere), token))
      .toEqual({ type: "denied" });
  });

  test("entity identities and revisions are stable opaque PRF outputs within one partition", async () => {
    const identity = await make();
    const entity = await makeEntityIdentity(sealing, identity.authenticator, 42);
    expect(entity).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await makeEntityIdentity(sealing, identity.authenticator, 42)).toBe(entity);
    expect(await makeEntityIdentity(sealing, identity.authenticator, 43)).not.toBe(entity);
    const revision = await makeRevision(sealing, identity, "S".repeat(43));
    expect(revision).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await makeRevision(sealing, identity, "S".repeat(43))).toBe(revision);
  });
});
