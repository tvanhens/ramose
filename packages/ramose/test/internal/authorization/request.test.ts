/**
 * executeAuthorizedRequest — authenticated caller + deployed unit → filtered Db.
 *
 * Real Connection + schemaTx + transact. Locally signed JWTs through JwtVerifier.
 * No mocks or fabricated stores.
 */

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import { exportJWK, generateKeyPair, SignJWT, type JWK, type JWTPayload } from "jose";
import { Unauthorized } from "../../../src/db/Errors.ts";
import {
  CatalogId,
  CatalogMismatch,
  CatalogUnitHash,
  SchemaFingerprint,
  assembleDeployedCatalogs,
  callerFromVerified,
  eq,
  executeAuthorizedRequest,
  hashCatalogSchemaFingerprint,
  me,
  read,
  type AuthorizedRequestInput,
  type AuthorizedRequestView,
  type DeployedCatalogs,
  type InstalledCatalogUnitV1,
} from "../../../src/internal/authorization/index.ts";
import { Connection } from "../../../src/internal/core/conn.ts";
import { Index } from "../../../src/internal/core/datom.ts";
import type { Db } from "../../../src/internal/core/db.ts";
import { schemaTx } from "../../../src/db/internal.ts";
import { fromEnv, resetJwtVerifier } from "../../../src/worker/jwt.ts";
import { digestHex } from "./fixtures.ts";
import {
  App,
  Issue,
  catalog,
  catalogDescriptor,
  compileRules,
  database,
  expectOk,
  version,
} from "./semantic-fixtures.ts";

const ISS = "https://issuer.example.test";
const AUD = "ramose:test";

interface TestKey {
  readonly kid: string;
  readonly privateKey: CryptoKey;
  readonly publicJwk: JWK;
}

let keyA: TestKey;

beforeAll(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  keyA = {
    kid: "key-a",
    privateKey: pair.privateKey,
    publicJwk: {
      ...(await exportJWK(pair.publicKey)),
      alg: "ES256",
      kid: "key-a",
      use: "sig",
    },
  };
});

beforeEach(() => {
  resetJwtVerifier();
});

const nowSeconds = (): number => Math.floor(Date.now() / 1_000);

const env = (keys: readonly JWK[] = [keyA.publicJwk]) =>
  ({
    RAMOSE_JWKS_JSON: JSON.stringify({ keys }),
    RAMOSE_JWT_ISS: ISS,
    RAMOSE_JWT_AUD: AUD,
    RAMOSE_JWT_MAX_TTL: "900",
  }) as Parameters<typeof fromEnv>[0];

const payload = (over: Record<string, unknown> = {}): JWTPayload => {
  const now = nowSeconds();
  return {
    iss: ISS,
    aud: AUD,
    sub: "alice-sub",
    iat: now,
    exp: now + 300,
    ramose: { db: "todos", class: "member", attrs: { org: "acme" } },
    ...over,
  };
};

const sign = async (options: { readonly payload?: JWTPayload } = {}): Promise<string> =>
  new SignJWT(options.payload ?? payload())
    .setProtectedHeader({ alg: "ES256", kid: keyA.kid })
    .sign(keyA.privateKey);

const verifier = () => fromEnv(env());

const authenticateToken = (token: string) =>
  verifier()
    .verify(Redacted.make(token))
    .pipe(Effect.map(callerFromVerified));

const sealedDescriptor = async () => {
  const base = catalogDescriptor();
  const fingerprint = await Effect.runPromise(hashCatalogSchemaFingerprint(base));
  return { ...base, fingerprint };
};

const deployOwnerPolicy = async (): Promise<DeployedCatalogs> => {
  const descriptor = await sealedDescriptor();
  return Effect.runPromise(
    assembleDeployedCatalogs({
      root: catalog,
      units: [
        {
          catalog,
          database,
          version,
          descriptor,
          policy: expectOk(compileRules([read(Issue).when(eq(Issue.owner, me))])),
        },
      ],
    }),
  );
};

const installEntityKinds = (conn: Connection, namespaces: readonly string[]) =>
  conn.transact(
    namespaces.map((ns) => ({
      ":db/ident": `:${ns}`,
      ":ramose/kind": ":ramose.kind/entity",
    })),
  );

const seedApp = async () => {
  const conn = await Connection.create();
  await conn.transact(schemaTx(App));
  await installEntityKinds(conn, ["user", "workspace", "tag"]);
  const report = await conn.transact([
    { ":db/id": "alice", ":ramose/type": ":user", ":user/authId": "alice-sub" },
    { ":db/id": "bob", ":ramose/type": ":user", ":user/authId": "bob-sub" },
    { ":db/id": "ws", ":ramose/type": ":workspace", ":workspace/members": "alice" },
    {
      ":db/id": "i1",
      ":ramose/type": ":issue",
      ":issue/title": "Bug",
      ":issue/owner": "alice",
      ":issue/workspace": "ws",
      ":issue/parent": "i1",
      ":taggable/tags": "alice",
    },
    {
      ":db/id": "i2",
      ":ramose/type": ":issue",
      ":issue/title": "Other",
      ":issue/owner": "bob",
      ":issue/workspace": "ws",
      ":issue/parent": "i1",
    },
  ]);
  return {
    conn,
    aliceEid: report.tempids["alice"]!,
    bobEid: report.tempids["bob"]!,
    i1: report.tempids["i1"]!,
    i2: report.tempids["i2"]!,
    createdT: report.t,
  };
};

const refOf = (catalogs: DeployedCatalogs) => {
  const deployed = Result.getOrThrow(catalogs.require(catalog));
  return { catalogKey: catalog, unitHash: deployed.unitHash };
};

const run = <A>(
  input: AuthorizedRequestInput,
  execute: (filteredDb: Db) => Effect.Effect<A>,
) => Effect.runPromise(executeAuthorizedRequest(input, execute));

const runFail = (
  input: AuthorizedRequestInput,
  execute: (filteredDb: Db) => Effect.Effect<unknown> = () => Effect.void,
) => Effect.runPromise(Effect.flip(executeAuthorizedRequest(input, execute)));

const expectOpaque = (error: unknown, secrets: readonly string[] = []) => {
  expect((error as { readonly _tag?: unknown })._tag).toBe("Unauthorized");
  expect(error).toBeInstanceOf(Unauthorized);
  expect((error as Error).message).toBe("");
  const encoded = JSON.stringify(error);
  for (const secret of secrets) expect(encoded).not.toContain(secret);
  expect(encoded).not.toContain("JWT");
  expect(encoded).not.toContain("JWKS");
  expect(encoded).not.toContain("kid");
  expect(encoded).not.toMatch(/[0-9a-f]{64}/);
};

const visibleTitle = async (db: Db, eid: number): Promise<string | undefined> => {
  const entity = await db.entity(eid);
  const title = entity?.[":issue/title"];
  return typeof title === "string" ? title : undefined;
};

describe("executeAuthorizedRequest", () => {
  test("authenticated matching catalog yields a filtered Db; alice sees i1 not i2", async () => {
    const { conn, i1, i2 } = await seedApp();
    const catalogs = await deployOwnerPolicy();
    const token = await sign();
    let acquired = 0;
    const { filtered, titles } = await run(
      {
        authenticate: authenticateToken(token),
        catalogs,
        catalogRef: refOf(catalogs),
        currentDb: Effect.sync(() => {
          acquired += 1;
          return conn.db();
        }),
      },
      (filteredDb) =>
        Effect.promise(async () => ({
          filtered: filteredDb,
          titles: {
            i1: await visibleTitle(filteredDb, i1),
            i2: await visibleTitle(filteredDb, i2),
          },
        })),
    );
    expect(acquired).toBe(1);
    expect(filtered.filters.length).toBeGreaterThanOrEqual(1);
    expect(titles.i1).toBe("Bug");
    expect(titles.i2).toBeUndefined();
    expect("unfiltered" in filtered).toBe(false);
    expect(Object.hasOwn(filtered, "unfilteredView")).toBe(false);
    expect(Object.keys(filtered)).not.toContain("unfilteredView");
  });

  test("current / asOf / history differ only in the Db passed to filter (HIST-2)", async () => {
    const { conn, bobEid, i1, createdT } = await seedApp();
    const catalogs = await deployOwnerPolicy();
    const token = await sign();
    await conn.transact([{ ":db/id": i1, ":issue/owner": bobEid }]);

    const ask = (view: AuthorizedRequestView) =>
      run(
        {
          authenticate: authenticateToken(token),
          catalogs,
          catalogRef: refOf(catalogs),
          currentDb: Effect.sync(() => conn.db()),
          view,
        },
        (filteredDb) =>
          Effect.promise(async () => ({
            title: await visibleTitle(filteredDb, i1),
            asOfT: filteredDb.asOfT,
            isHistory: filteredDb.isHistory,
            filters: filteredDb.filters.length,
          })),
      );

    const current = await ask({ kind: "current" });
    const asOf = await ask({ kind: "asOf", t: createdT });
    const history = await ask({ kind: "history" });
    expect(current.title).toBeUndefined();
    expect(asOf.title).toBeUndefined();
    expect(history.title).toBeUndefined();
    expect(current.asOfT).toBeUndefined();
    expect(current.isHistory).toBe(false);
    expect(asOf.asOfT).toBe(createdT);
    expect(asOf.isHistory).toBe(false);
    expect(history.isHistory).toBe(true);
    expect(current.filters).toBe(asOf.filters);
    expect(current.filters).toBe(history.filters);

    const unfilteredAsOf = conn.db().asOf(createdT);
    expect(await visibleTitle(unfilteredAsOf, i1)).toBe("Bug");
  });

  test("missing catalog key is Unauthorized; currentDb and execute do not run", async () => {
    const catalogs = await deployOwnerPolicy();
    const token = await sign();
    let acquired = false;
    let executed = false;
    const missing = CatalogId.make("other");
    const error = await runFail(
      {
        authenticate: authenticateToken(token),
        catalogs,
        catalogRef: {
          catalogKey: missing,
          unitHash: CatalogUnitHash.make(digestHex(0xab)),
        },
        currentDb: Effect.sync(() => {
          acquired = true;
          throw new Error("currentDb must not run");
        }),
      },
      () =>
        Effect.sync(() => {
          executed = true;
        }),
    );
    expect(acquired).toBe(false);
    expect(executed).toBe(false);
    expectOpaque(error, ["other", digestHex(0xab), catalog]);
  });

  test("unit-hash mismatch is Unauthorized before currentDb and execute", async () => {
    const catalogs = await deployOwnerPolicy();
    const token = await sign();
    const wrong = CatalogUnitHash.make(digestHex(0xcd));
    let acquired = false;
    let executed = false;
    const error = await runFail(
      {
        authenticate: authenticateToken(token),
        catalogs,
        catalogRef: { catalogKey: catalog, unitHash: wrong },
        currentDb: Effect.sync(() => {
          acquired = true;
          throw new Error("currentDb must not run");
        }),
      },
      () =>
        Effect.sync(() => {
          executed = true;
        }),
    );
    expect(acquired).toBe(false);
    expect(executed).toBe(false);
    expectOpaque(error, [wrong, "expected", "actual", Result.getOrThrow(catalogs.require(catalog)).unitHash]);
  });

  test("failed JWT is Unauthorized; currentDb and execute do not run", async () => {
    const catalogs = await deployOwnerPolicy();
    let acquired = false;
    let executed = false;
    const error = await runFail(
      {
        authenticate: authenticateToken("not-a-jwt"),
        catalogs,
        catalogRef: refOf(catalogs),
        currentDb: Effect.sync(() => {
          acquired = true;
          throw new Error("currentDb must not run");
        }),
      },
      () =>
        Effect.sync(() => {
          executed = true;
        }),
    );
    expect(acquired).toBe(false);
    expect(executed).toBe(false);
    expectOpaque(error);
  });

  test("missing deployed policy or prepare failure is Unauthorized before execute", async () => {
    const { conn } = await seedApp();
    const catalogs = await deployOwnerPolicy();
    const token = await sign();
    const real = Result.getOrThrow(catalogs.require(catalog));
    const broken = (unit: InstalledCatalogUnitV1): DeployedCatalogs =>
      Object.freeze({
        require: (catalogKey) => {
          if (catalogKey !== catalog) {
            return Result.fail(new CatalogMismatch({ message: "catalog mismatch", expected: catalogKey }));
          }
          return Result.succeed({
            catalogKey: catalog,
            unitHash: real.unitHash,
            unit,
          });
        },
        keys: () => catalogs.keys(),
      });

    const missingPolicy = broken({ ...real.unit, policy: undefined as never });
    const malformedCatalog = broken({
      ...real.unit,
      catalog: { ...real.unit.catalog, fingerprint: SchemaFingerprint.make("") },
    });

    for (const fixture of [missingPolicy, malformedCatalog]) {
      let acquired = false;
      let executed = false;
      const error = await runFail(
        {
          authenticate: authenticateToken(token),
          catalogs: fixture,
          catalogRef: { catalogKey: catalog, unitHash: real.unitHash },
          currentDb: Effect.sync(() => {
            acquired = true;
            return conn.db();
          }),
        },
        () =>
          Effect.sync(() => {
            executed = true;
          }),
      );
      expect(acquired).toBe(false);
      expect(executed).toBe(false);
      expectOpaque(error, [real.unitHash, catalog]);
    }
  });

  test("database acquisition failure is Unauthorized; execute is not called", async () => {
    const catalogs = await deployOwnerPolicy();
    const token = await sign();
    let executed = false;
    const error = await runFail(
      {
        authenticate: authenticateToken(token),
        catalogs,
        catalogRef: refOf(catalogs),
        currentDb: Effect.fail({ _tag: "AcquisitionFailed" as const }),
      },
      () =>
        Effect.sync(() => {
          executed = true;
        }),
    );
    expect(executed).toBe(false);
    expectOpaque(error, ["AcquisitionFailed"]);
  });

  test("timeout of the whole operation is Unauthorized", async () => {
    const catalogs = await deployOwnerPolicy();
    const token = await sign();
    let executed = false;
    const error = await runFail(
      {
        authenticate: authenticateToken(token),
        catalogs,
        catalogRef: refOf(catalogs),
        currentDb: Effect.never,
        interruptAfter: 20,
      },
      () =>
        Effect.sync(() => {
          executed = true;
        }),
    );
    expect(executed).toBe(false);
    expectOpaque(error);
  });

  test("timeout during execute is Unauthorized", async () => {
    const { conn } = await seedApp();
    const catalogs = await deployOwnerPolicy();
    const token = await sign();
    const error = await runFail(
      {
        authenticate: authenticateToken(token),
        catalogs,
        catalogRef: refOf(catalogs),
        currentDb: Effect.sync(() => conn.db()),
        interruptAfter: 20,
      },
      () => Effect.never,
    );
    expectOpaque(error);
  });

  test("execute is the only consumer and cannot see hidden i2 title", async () => {
    const { conn, i1, i2 } = await seedApp();
    const catalogs = await deployOwnerPolicy();
    const token = await sign();
    const titleAttr = conn.db().requireAttr(":issue/title").id;
    const seen = await run(
      {
        authenticate: authenticateToken(token),
        catalogs,
        catalogRef: refOf(catalogs),
        currentDb: Effect.sync(() => conn.db()),
      },
      (filteredDb) =>
        Effect.promise(async () => ({
          i1: await filteredDb.entity(i1),
          i2: await filteredDb.entity(i2),
          i2Title: await filteredDb.first(Index.EAVT, { e: i2, a: titleAttr }),
          i2Aevt: await filteredDb.datomsArray(Index.AEVT, { a: titleAttr }),
        })),
    );
    expect(seen.i1?.[":issue/title"]).toBe("Bug");
    expect(seen.i2?.[":issue/title"]).toBeUndefined();
    expect(seen.i2Title).toBeUndefined();
    expect(seen.i2Aevt.filter((datom) => datom.e === i2)).toEqual([]);
  });

  test("authorizes from the registry; Connection holds only application schemaTx+data", async () => {
    const { conn, i1 } = await seedApp();
    const catalogs = await deployOwnerPolicy();
    const token = await sign();
    const latest = conn.db();
    expect(latest.schema.attr(":catalog/unit")).toBeUndefined();
    expect(latest.schema.attr(":catalog/head")).toBeUndefined();
    expect(latest.schema.attr(":catalog/policy")).toBeUndefined();
    const title = await run(
      {
        authenticate: authenticateToken(token),
        catalogs,
        catalogRef: refOf(catalogs),
        currentDb: Effect.succeed(latest),
      },
      (filteredDb) => Effect.promise(() => visibleTitle(filteredDb, i1)),
    );
    expect(title).toBe("Bug");
  });
});
