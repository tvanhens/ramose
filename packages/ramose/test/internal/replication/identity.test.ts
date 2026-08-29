import { describe, expect, test } from "bun:test";
import {
  CatalogId,
  CatalogUnitHash,
  DatabaseId,
  type AuthenticatedCaller,
  type GraphPathLeaseIdentity,
} from "../../../src/internal/authorization/index.ts";
import {
  makeEntityIdentity,
  makeReplicationIdentity,
  makeRevision,
} from "../../../src/internal/replication/index.ts";

const secret = "replication-test-secret-that-is-long-enough";
const digest = (character: string) => character.repeat(64);
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

const make = (options: {
  caller?: AuthenticatedCaller;
  path?: GraphPathLeaseIdentity;
  deployment?: string;
} = {}) => makeReplicationIdentity({
  secret,
  origin: "https://ramose.test",
  deployment: options.deployment ?? "deployment-1",
  caller: options.caller ?? caller(2_000_000_000),
  path: options.path ?? path(),
});

describe("opaque replication identities", () => {
  test("ordinary token refresh is stable", async () => {
    expect(await make({ caller: caller(2_000_000_000) }))
      .toEqual(await make({ caller: caller(2_100_000_000) }));
  });

  test("principal, claim view, class, catalog, database, and deployment partition", async () => {
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
      await make({ path: path("child-db", "issues", digest("c")) }),
      await make({ deployment: "deployment-2" }),
    ];
    for (const replacement of changed) {
      expect(replacement.authenticator).not.toBe(baseline.authenticator);
      expect(replacement.readView === baseline.readView &&
        replacement.principal === baseline.principal &&
        replacement.database === baseline.database &&
        replacement.catalog === baseline.catalog).toBe(false);
    }
  });

  test("entity identities and revisions are stable opaque PRF outputs within one partition", async () => {
    const identity = await make();
    const entity = await makeEntityIdentity(secret, identity.authenticator, 42);
    expect(entity).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await makeEntityIdentity(secret, identity.authenticator, 42)).toBe(entity);
    expect(await makeEntityIdentity(secret, identity.authenticator, 43)).not.toBe(entity);
    const revision = await makeRevision(secret, identity, "S".repeat(43));
    expect(revision).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await makeRevision(secret, identity, "S".repeat(43))).toBe(revision);
  });
});
