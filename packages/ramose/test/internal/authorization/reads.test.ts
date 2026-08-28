/**
 * #423 — every one-shot read shape runs on the filtered Db from
 * executeAuthorizedRequest. Paired-world: hidden datoms cannot affect
 * query, pull, entity, lookup, refs, graph, aggregation, sort, or limit.
 *
 * Real Connection + schemaTx + transact. Locally signed JWTs. No mocks.
 */

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { pipe } from "effect/Function";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import { exportJWK, generateKeyPair, SignJWT, type JWK, type JWTPayload } from "jose";
import { Query, compositionFromSchema, lowerQueryObject, schemaTx } from "../../../src/db/internal.ts";
import {
  DatabaseId,
  allow,
  assembleDeployedCatalogs,
  callerFromVerified,
  eq,
  executeAuthorizedRead,
  executeAuthorizedRequest,
  hashCatalogSchemaFingerprint,
  me,
  read,
  subject,
  type AuthorizedRequestInput,
  type DeployedCatalogs,
  type OneShotRead,
} from "../../../src/internal/authorization/index.ts";
import { Connection } from "../../../src/internal/core/conn.ts";
import type { Db } from "../../../src/internal/core/db.ts";
import { query } from "../../../src/internal/core/query/engine.ts";
import { pull } from "../../../src/internal/core/query/pull.ts";
import { fromEnv, resetJwtVerifier } from "../../../src/worker/jwt.ts";
import {
  App,
  Issue,
  Tag,
  Taggable,
  User,
  Workspace,
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
    ramose: { class: "member", attrs: { org: "acme" } },
    ...over,
  };
};

const sign = async (options: { readonly payload?: JWTPayload } = {}): Promise<string> =>
  new SignJWT(options.payload ?? payload())
    .setProtectedHeader({ alg: "ES256", kid: keyA.kid })
    .sign(keyA.privateKey);

const authenticateToken = (token: string) =>
  fromEnv(env())
    .verify(Redacted.make(token))
    .pipe(Effect.map(callerFromVerified));

const sealedDescriptor = async (db: DatabaseId = database) => {
  const base = { ...catalogDescriptor(), database: db };
  const fingerprint = await Effect.runPromise(hashCatalogSchemaFingerprint(base));
  return { ...base, fingerprint };
};

const deployPolicy = async (
  rules: Parameters<typeof compileRules>[0],
  extras: Parameters<typeof compileRules>[1] = {},
  db: DatabaseId = database,
): Promise<DeployedCatalogs> => {
  const descriptor = await sealedDescriptor(db);
  return Effect.runPromise(
    assembleDeployedCatalogs({
      root: catalog,
      units: [
        {
          catalog,
          database: db,
          version,
          descriptor,
          policy: expectOk(compileRules(rules, extras)),
        },
      ],
    }),
  );
};

const ownerPolicy = (): Promise<DeployedCatalogs> =>
  deployPolicy([
    read(Issue).when(eq(Issue.owner, me)),
    read(User).when(eq(User.authId, subject)),
  ]);

const acceptAllPolicy = (): Promise<DeployedCatalogs> =>
  deployPolicy([
    read(Issue).when(allow),
    read(User).when(allow),
    read(Workspace).when(allow),
    read(Tag).when(allow),
    read(Taggable).when(allow),
  ]);

const seedWorld = async (includeHiddenIssue: boolean) => {
  const conn = await Connection.create({
    composition: compositionFromSchema(App),
  });
  await conn.transact(schemaTx(App));
  const tx: Record<string, unknown>[] = [
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
      ":db/id": "i3",
      ":ramose/type": ":issue",
      ":issue/title": "Child",
      ":issue/owner": "alice",
      ":issue/workspace": "ws",
      ":issue/parent": "i1",
    },
  ];
  if (includeHiddenIssue) {
    tx.push({
      ":db/id": "i2",
      ":ramose/type": ":issue",
      ":issue/title": "Other",
      ":issue/owner": "bob",
      ":issue/workspace": "ws",
      ":issue/parent": "i1",
      ":taggable/tags": "bob",
    });
  }
  const report = await conn.transact(tx);
  return {
    conn,
    aliceEid: report.tempids["alice"]!,
    bobEid: report.tempids["bob"]!,
    wsEid: report.tempids["ws"]!,
    i1: report.tempids["i1"]!,
    i2: report.tempids["i2"],
    i3: report.tempids["i3"]!,
    createdT: report.t,
  };
};

const proofOf = (catalogs: DeployedCatalogs, route: DatabaseId = database) => {
  const deployed = Result.getOrThrow(catalogs.requireDatabase(route));
  return { catalogKey: deployed.catalogKey, unitHash: deployed.unitHash };
};

const inputOf = (
  catalogs: DeployedCatalogs,
  token: string,
  conn: Connection,
  view?: AuthorizedRequestInput["view"],
): AuthorizedRequestInput => ({
  authenticate: authenticateToken(token),
  catalogs,
  routeDatabase: database,
  ...proofOf(catalogs),
  currentDb: (db) => {
    expect(db).toBe(database);
    return Effect.sync(() => conn.db());
  },
  ...(view === undefined ? {} : { view }),
});

const runRead = (input: AuthorizedRequestInput, read: OneShotRead, opts?: { maxCells?: number }) =>
  Effect.runPromise(executeAuthorizedRead(input, read, opts));

const sortRows = (rows: unknown) =>
  (Array.isArray(rows) ? rows : []).map((row) => JSON.stringify(row)).sort();

const titlesQuery = `[:find [?t ...] :where [?e :issue/title ?t]]`;
const joinQuery = `[:find ?t ?n :where [?e :issue/title ?t] [?e :issue/owner ?u] [?u :user/authId ?n]]`;
const childQuery = `[:find [?t ...] :in $ ?p :where [?c :issue/parent ?p] [?c :issue/title ?t]]`;
const traitRootQuery = `[:find [?t ...] :where [?e :ramose/type :issue] [?e :issue/title ?t]]`;
const traitFieldQuery = `[:find [?t ...] :where [?e :taggable/tags _] [?e :issue/title ?t]]`;
const countQuery = `[:find (count ?e) . :where [?e :issue/title]]`;
const notQuery = `[:find [?t ...] :where [?e :issue/title ?t] (not [?e :taggable/tags _])]`;
const orderLimitQuery = {
  find: [["?t", "..."]],
  where: [["?e", ":issue/title", "?t"]],
  order: [["?t"]],
  limit: 2,
};

const issueListing = Query.q(() =>
  pipe(Query.entities(Issue), Query.select({ id: Issue.id, title: Issue.title })),
);

type Observation = {
  titles: unknown;
  joins: unknown;
  children: unknown;
  traitRoots: unknown;
  traitFields: unknown;
  count: unknown;
  negation: unknown;
  ordered: unknown;
  typedTitles: unknown;
  pullI1: unknown;
  nestedPullI1: unknown;
  reversePullI1: unknown;
  pullMissing: unknown;
  entityI1: unknown;
  entityMissing: unknown;
  lookupAlice: unknown;
  lookupBob: unknown;
  lookupGhost: unknown;
};

const observe = async (db: Db, i1: number, missingEid: number): Promise<Observation> => {
  const lowered = lowerQueryObject(issueListing);
  const typed = lowered.finalize(await query(db, lowered.query));
  return {
    titles: ((await query(db, titlesQuery)) as string[]).sort(),
    joins: sortRows(await query(db, joinQuery)),
    children: ((await query(db, childQuery, [i1])) as string[]).sort(),
    traitRoots: ((await query(db, traitRootQuery)) as string[]).sort(),
    traitFields: ((await query(db, traitFieldQuery)) as string[]).sort(),
    count: await query(db, countQuery),
    negation: ((await query(db, notQuery)) as string[]).sort(),
    ordered: await query(db, orderLimitQuery),
    typedTitles: (typed as { title: string }[]).map((row) => row.title).sort(),
    pullI1: await pull(db, i1, `[:issue/title :issue/owner {:issue/_parent [:issue/title]}]`),
    nestedPullI1: await pull(db, i1, `[:issue/title {:issue/parent [:issue/title]}]`),
    reversePullI1: await pull(db, i1, `[{:issue/_parent [:issue/title]}]`),
    pullMissing: await pull(db, missingEid, `[*]`),
    entityI1: await db.entity(i1),
    entityMissing: (await db.entity(missingEid)) ?? null,
    lookupAlice: (await db.entid([":user/authId", "alice-sub"])) ?? null,
    lookupBob: (await db.entid([":user/authId", "bob-sub"])) ?? null,
    lookupGhost: (await db.entid([":user/authId", "ghost-sub"])) ?? null,
  };
};

const publicObservation = (obs: Observation) => ({
  titles: obs.titles,
  joins: obs.joins,
  children: obs.children,
  traitRoots: obs.traitRoots,
  traitFields: obs.traitFields,
  count: obs.count,
  negation: obs.negation,
  ordered: obs.ordered,
  typedTitles: obs.typedTitles,
  pullI1: obs.pullI1,
  nestedPullI1: obs.nestedPullI1,
  reversePullI1: obs.reversePullI1,
  pullMissing: obs.pullMissing,
  entityI1Title: (obs.entityI1 as { ":issue/title"?: string } | null)?.[":issue/title"],
  entityI1Owner: (obs.entityI1 as { ":issue/owner"?: number } | null)?.[":issue/owner"],
  entityMissing: obs.entityMissing,
  lookupAlice: obs.lookupAlice === null ? null : "hit",
  lookupBob: obs.lookupBob,
  lookupGhost: obs.lookupGhost,
});

describe("executeAuthorizedRead uses the constructor's filtered Db", () => {
  test("query / pull / entity / lookup all see i1 and not i2", async () => {
    const hidden = await seedWorld(true);
    const catalogs = await ownerPolicy();
    const token = await sign();
    const input = inputOf(catalogs, token, hidden.conn);
    let seen: Db | undefined;
    await Effect.runPromise(
      executeAuthorizedRequest(input, (filteredDb) =>
        Effect.sync(() => {
          seen = filteredDb;
        }),
      ),
    );
    expect(seen).toBeDefined();
    expect(seen!.filters.length).toBeGreaterThanOrEqual(1);

    const titles = await runRead(input, { kind: "query", query: titlesQuery });
    const pulled = await runRead(input, {
      kind: "pull",
      eid: hidden.i1,
      pattern: `[:issue/title :issue/owner]`,
    });
    const entity = await runRead(input, { kind: "entity", ref: hidden.i1 });
    const hiddenEntity = await runRead(input, { kind: "entity", ref: hidden.i2! });
    const lookupBob = await runRead(input, { kind: "lookup", ref: [":user/authId", "bob-sub"] });
    const lookupAlice = await runRead(input, { kind: "lookup", ref: [":user/authId", "alice-sub"] });
    const pullHidden = await runRead(input, { kind: "pull", eid: hidden.i2!, pattern: `[*]` });

    expect((titles as string[]).sort()).toEqual(["Bug", "Child"]);
    expect((pulled as { ":issue/title": string })[":issue/title"]).toBe("Bug");
    expect((pulled as { ":issue/owner": { ":db/id": number } })[":issue/owner"]).toEqual({
      ":db/id": hidden.aliceEid,
    });
    expect((entity as { ":issue/title": string })[":issue/title"]).toBe("Bug");
    expect((entity as { ":issue/owner": number })[":issue/owner"]).toBe(hidden.aliceEid);
    expect(hiddenEntity).toBeNull();
    expect(pullHidden).toBeNull();
    expect(lookupBob).toBeNull();
    expect(lookupAlice).toBe(hidden.aliceEid);
    expect(JSON.stringify({ titles, pulled, entity, hiddenEntity, lookupBob })).not.toMatch(
      /"t"|explain|basis|planner/,
    );
  });

  test("ordinary query/pull is unchanged when every catalog rule allows", async () => {
    const world = await seedWorld(true);
    const catalogs = await acceptAllPolicy();
    const token = await sign();
    const input = inputOf(catalogs, token, world.conn);
    const filteredTitles = await runRead(input, { kind: "query", query: titlesQuery });
    const raw = world.conn.db();
    expect(((filteredTitles as string[]) ?? []).sort()).toEqual(
      ((await query(raw, titlesQuery)) as string[]).sort(),
    );
    expect(await runRead(input, { kind: "pull", eid: world.i2!, pattern: `[:issue/title]` })).toEqual(
      await pull(raw, world.i2!, `[:issue/title]`),
    );
    expect(await runRead(input, { kind: "lookup", ref: [":user/authId", "bob-sub"] })).toBe(world.bobEid);
  });
});

describe("paired-world: hidden datoms cannot affect one-shot reads", () => {
  test("a world with i2 and a world that never had i2 are identical to alice", async () => {
    const withHidden = await seedWorld(true);
    const without = await seedWorld(false);
    const catalogs = await ownerPolicy();
    const token = await sign();

    const seenWith = await Effect.runPromise(
      executeAuthorizedRequest(inputOf(catalogs, token, withHidden.conn), (db) =>
        Effect.promise(() => observe(db, withHidden.i1, withHidden.i2!)),
      ),
    );
    const seenWithout = await Effect.runPromise(
      executeAuthorizedRequest(inputOf(catalogs, token, without.conn), (db) =>
        Effect.promise(() => observe(db, without.i1, withHidden.i2!)),
      ),
    );

    expect(publicObservation(seenWith)).toEqual(publicObservation(seenWithout));
    expect(seenWith.titles).toEqual(["Bug", "Child"]);
    expect(seenWith.children).toEqual(["Bug", "Child"]);
    expect(seenWith.traitRoots).toEqual(["Bug", "Child"]);
    expect(seenWith.traitFields).toEqual([]);
    expect(seenWith.count).toBe(2);
    expect(seenWith.negation).toEqual(["Bug", "Child"]);
    expect(seenWith.ordered).toEqual(["Bug", "Child"]);
    expect(seenWith.lookupBob).toBeNull();
    expect(seenWith.lookupGhost).toBeNull();
    expect(seenWith.pullMissing).toBeNull();
    expect(seenWith.entityMissing).toBeNull();
    expect(seenWith.joins).toEqual(sortRows([["Bug", "alice-sub"], ["Child", "alice-sub"]]));
    expect(JSON.stringify(seenWith.pullI1)).not.toContain("Other");
    expect(JSON.stringify(seenWith.reversePullI1)).not.toContain("Other");
  });

  test("hidden datoms cannot join, aggregate, negate, sort, limit, or walk refs", async () => {
    const world = await seedWorld(true);
    const catalogs = await ownerPolicy();
    const token = await sign();
    const input = inputOf(catalogs, token, world.conn);

    const titles = await runRead(input, { kind: "query", query: titlesQuery });
    const joins = await runRead(input, { kind: "query", query: joinQuery });
    const children = await runRead(input, { kind: "query", query: childQuery, inputs: [world.i1] });
    const count = await runRead(input, { kind: "query", query: countQuery });
    const negation = await runRead(input, { kind: "query", query: notQuery });
    const ordered = await runRead(input, { kind: "query", query: orderLimitQuery });
    const graph = await runRead(input, {
      kind: "query",
      query: `[:find ?t ?pt :where [?c :issue/parent ?p] [?c :issue/title ?t] [?p :issue/title ?pt]]`,
    });
    const reverse = await runRead(input, {
      kind: "pull",
      eid: world.i1,
      pattern: `[{:issue/_parent [:issue/title]}]`,
    });

    expect((titles as string[]).sort()).toEqual(["Bug", "Child"]);
    expect(sortRows(joins)).toEqual(sortRows([["Bug", "alice-sub"], ["Child", "alice-sub"]]));
    expect((children as string[]).sort()).toEqual(["Bug", "Child"]);
    expect(count).toBe(2);
    expect((negation as string[]).sort()).toEqual(["Bug", "Child"]);
    expect(ordered).toEqual(["Bug", "Child"]);
    expect(sortRows(graph)).toEqual(sortRows([["Bug", "Bug"], ["Child", "Bug"]]));
    expect(reverse).toEqual({
      ":issue/_parent": [{ ":issue/title": "Bug" }, { ":issue/title": "Child" }],
    });
  });

  test("hidden and nonexistent targets are indistinguishable; wrong-type after readability", async () => {
    const world = await seedWorld(true);
    const catalogs = await ownerPolicy();
    const token = await sign();
    const input = inputOf(catalogs, token, world.conn);
    const missing = 9_000_001;

    expect(await runRead(input, { kind: "entity", ref: world.i2! })).toBe(
      await runRead(input, { kind: "entity", ref: missing }),
    );
    expect(await runRead(input, { kind: "pull", eid: world.i2!, pattern: `[*]` })).toBe(
      await runRead(input, { kind: "pull", eid: missing, pattern: `[*]` }),
    );
    expect(await runRead(input, { kind: "lookup", ref: [":user/authId", "bob-sub"] })).toBe(
      await runRead(input, { kind: "lookup", ref: [":user/authId", "ghost-sub"] }),
    );

    const open = inputOf(await acceptAllPolicy(), token, world.conn);
    expect(await runRead(open, { kind: "lookup", ref: [":user/authId", "bob-sub"] })).toBe(world.bobEid);
    expect(await runRead(open, { kind: "entity", ref: world.i2! })).not.toBeNull();
    await expect(runRead(open, { kind: "lookup", ref: [":user/authId", 123] })).rejects.toThrow();
    await expect(runRead(input, { kind: "lookup", ref: [":user/authId", 123] })).rejects.toThrow();
  });

  test("as-of and history use the same filtered value the constructor composed", async () => {
    const world = await seedWorld(true);
    const catalogs = await ownerPolicy();
    const token = await sign();
    await world.conn.transact([{ ":db/id": world.i1, ":issue/owner": world.bobEid }]);

    const current = await runRead(inputOf(catalogs, token, world.conn), {
      kind: "query",
      query: titlesQuery,
    });
    const asOf = await runRead(inputOf(catalogs, token, world.conn, { asOf: world.createdT }), {
      kind: "query",
      query: titlesQuery,
    });
    const history = await runRead(inputOf(catalogs, token, world.conn, { history: true }), {
      kind: "query",
      query: `[:find [?t ...] :where [?e :issue/title ?t]]`,
    });
    expect((current as string[]).sort()).toEqual(["Child"]);
    expect((asOf as string[]).sort()).toEqual(["Child"]);
    expect((history as string[]).sort()).toEqual(["Child"]);
    expect(await query(world.conn.db().asOf(world.createdT), titlesQuery)).toEqual(
      expect.arrayContaining(["Bug"]),
    );
  });

  test("optional query stats cannot change the authorized result", async () => {
    const world = await seedWorld(true);
    const catalogs = await ownerPolicy();
    const token = await sign();
    const input = inputOf(catalogs, token, world.conn);
    const read: OneShotRead = { kind: "query", query: joinQuery };
    const plain = await Effect.runPromise(
      executeAuthorizedRequest(input, (db) => Effect.promise(() => query(db, joinQuery))),
    );
    const withStats = await Effect.runPromise(
      executeAuthorizedRequest(input, (db) =>
        Effect.promise(() => query(db, joinQuery, [], { stats: { clauses: [] } })),
      ),
    );
    const tightBudget = await runRead(input, read, { maxCells: 1_000_000 });
    expect(sortRows(plain)).toEqual(sortRows(withStats));
    expect(sortRows(plain)).toEqual(sortRows(tightBudget));
    expect(sortRows(plain)).toEqual(sortRows([["Bug", "alice-sub"], ["Child", "alice-sub"]]));
  });
});
