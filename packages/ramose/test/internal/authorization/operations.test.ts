/**
 * executeAuthorizedWrite — catalog-bound operations on a real Connection.
 *
 * Real schemaTx + transact + locally signed JWTs. No mocks.
 */

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import { exportJWK, generateKeyPair, SignJWT, type JWK, type JWTPayload } from "jose";
import { OperationRejected, Unauthorized } from "../../../src/db/Errors.ts";
import { Operation, defineOperations, schemaTx } from "../../../src/db/internal.ts";
import {
  CatalogId,
  DatabaseId,
  EntityId,
  FieldId,
  OperationId,
  TraitId,
  assembleDeployedCatalogs,
  callerFromVerified,
  eq,
  executeAuthorizedWrite,
  hasClass,
  hashCatalogSchemaFingerprint,
  invoke,
  me,
  read,
  type AuthorizedWriteInput,
  type CatalogDescriptor,
  type DeployedCatalogs,
  type OperationInvocation,
} from "../../../src/internal/authorization/index.ts";
import { Connection } from "../../../src/internal/core/conn.ts";
import { Index } from "../../../src/internal/core/datom.ts";
import { RAMOSE_TRAIT, RAMOSE_TYPE } from "../../../src/internal/core/schema.ts";
import { fromEnv, resetJwtVerifier } from "../../../src/worker/jwt.ts";
import {
  App,
  Issue,
  User,
  catalog,
  catalogDescriptor,
  compileRules,
  database,
  expectOk,
  issueOwner,
  orgClaim,
  taggableOwner,
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

const writeDescriptor = async (): Promise<CatalogDescriptor> => {
  const base = catalogDescriptor();
  const descriptor: CatalogDescriptor = {
    ...base,
    fields: [
      ...base.fields,
      {
        id: FieldId.make({ catalog, owner: issueOwner, localName: "note" }),
        valueType: "string",
        cardinality: "one",
        index: false,
        optional: true,
        owned: false,
        defaultValue: "n/a",
      },
      {
        id: FieldId.make({ catalog, owner: issueOwner, localName: "source" }),
        valueType: "string",
        cardinality: "one",
        index: false,
        optional: true,
        owned: false,
        fixedValue: "op",
      },
      {
        id: FieldId.make({ catalog, owner: issueOwner, localName: "related" }),
        valueType: "ref",
        refTarget: { _tag: "trait", trait: TraitId.make({ catalog, name: "taggable" }) },
        cardinality: "one",
        index: false,
        optional: true,
        owned: false,
      },
    ],
    operations: [
      ...base.operations,
      {
        id: OperationId.make({ catalog, owner: issueOwner, localName: "create", target: "none" }),
        input: {
          _tag: "struct",
          fields: [
            { key: "title", optional: true, shape: { _tag: "scalar", valueType: "string" } },
            { key: "owner", optional: false, shape: { _tag: "ref", refTarget: { _tag: "entity", entity: EntityId.make({ catalog, name: "user" }) } } },
            { key: "workspace", optional: false, shape: { _tag: "ref", refTarget: { _tag: "entity", entity: EntityId.make({ catalog, name: "workspace" }) } } },
          ],
        },
      },
      {
        id: OperationId.make({ catalog, owner: taggableOwner, localName: "retag", target: "required" }),
        input: {
          _tag: "struct",
          fields: [{ key: "tag", optional: false, shape: { _tag: "ref", refTarget: { _tag: "entity", entity: EntityId.make({ catalog, name: "user" }) } } }],
        },
      },
      {
        id: OperationId.make({ catalog, owner: issueOwner, localName: "relate", target: "required" }),
        input: {
          _tag: "struct",
          fields: [{ key: "related", optional: false, shape: { _tag: "ref", refTarget: { _tag: "trait", trait: TraitId.make({ catalog, name: "taggable" }) } } }],
        },
      },
    ],
  };
  const fingerprint = await Effect.runPromise(hashCatalogSchemaFingerprint(descriptor));
  return { ...descriptor, fingerprint };
};

const deployWritePolicy = async (
  extras: Parameters<typeof compileRules>[1] = {},
): Promise<DeployedCatalogs> => {
  const descriptor = await writeDescriptor();
  return Effect.runPromise(
    assembleDeployedCatalogs({
      root: catalog,
      units: [
        {
          catalog,
          database,
          version,
          descriptor,
          policy: expectOk(
            compileRules(
              [
                read(Issue).when(eq(Issue.owner, me)),
                read(User).when(hasClass("member")),
                invoke({ owner: Issue, localName: "rename", target: "required" }).when(hasClass("member")),
                invoke({ owner: Issue, localName: "create", target: "none" }).when(hasClass("member")),
                invoke({ owner: taggableOwner, localName: "retag", target: "required" }).when(hasClass("member")),
                invoke({ owner: Issue, localName: "relate", target: "required" }).when(hasClass("member")),
              ],
              { ...extras, claims: extras.claims ?? [orgClaim] },
            ),
          ),
        },
      ],
    }),
  );
};

const deployReadOnlyPolicy = async (): Promise<DeployedCatalogs> => {
  const descriptor = await writeDescriptor();
  return Effect.runPromise(
    assembleDeployedCatalogs({
      root: catalog,
      units: [
        {
          catalog,
          database,
          version,
          descriptor,
          policy: expectOk(compileRules([read(Issue).when(eq(Issue.owner, me))], { claims: [orgClaim] })),
        },
      ],
    }),
  );
};

const signRamose = (
  over: { readonly sub?: string; readonly attrs?: Record<string, unknown>; readonly class?: string } = {},
) =>
  sign({
    payload: payload({
      ...(over.sub === undefined ? {} : { sub: over.sub }),
      ramose: {
        class: over.class ?? "member",
        attrs: over.attrs ?? { org: "acme" },
      },
    }),
  });

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
  await conn.transact([
    {
      ":db/ident": ":issue/note",
      ":db/valueType": ":db.type/string",
      ":db/cardinality": ":db.cardinality/one",
      ":db/optional": true,
    },
    {
      ":db/ident": ":issue/source",
      ":db/valueType": ":db.type/string",
      ":db/cardinality": ":db.cardinality/one",
      ":db/optional": true,
    },
    {
      ":db/ident": ":issue/related",
      ":db/valueType": ":db.type/ref",
      ":db/cardinality": ":db.cardinality/one",
      ":db/optional": true,
    },
  ]);
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
    ws: report.tempids["ws"]!,
    i1: report.tempids["i1"]!,
    i2: report.tempids["i2"]!,
  };
};

const proofOf = (catalogs: DeployedCatalogs, route: DatabaseId = database) => {
  const deployed = Result.getOrThrow(catalogs.requireDatabase(route));
  return { catalogKey: deployed.catalogKey, unitHash: deployed.unitHash };
};

const renameOp = Operation.patch("issue/rename", Issue, ["title"]);
const createOp = Operation(
  "issue/create",
  {
    input: Schema.Struct({
      title: Schema.optionalKey(Schema.String),
      owner: Schema.Finite,
      workspace: Schema.Finite,
      source: Schema.optionalKey(Schema.String),
    }),
    output: Schema.Struct({ id: Schema.Finite }),
    schema: App,
  },
  (op, input) => {
    const handle = op.entity();
    op.put(Issue, handle, {
      title: input.title ?? "untitled",
      owner: input.owner,
      workspace: input.workspace,
      parent: handle,
    });
    if (input.source !== undefined) {
      (op as { set: (e: unknown, f: string, v: unknown) => void }).set(handle, ":issue/source", input.source);
    }
    return { id: handle };
  },
);
const retagOp = Operation(
  "taggable/retag",
  {
    on: Issue,
    input: Schema.Struct({ tag: Schema.Finite }),
    schema: App,
  },
  (op, input) => {
    op.set(op.self!, Issue.tags, input.tag);
    return {};
  },
);
const relateOp = Operation(
  "issue/relate",
  {
    on: Issue,
    input: Schema.Struct({ related: Schema.Finite }),
    schema: App,
  },
  (op, input) => {
    (op as { set: (e: unknown, f: string, v: unknown) => void }).set(op.self!, ":issue/related", input.related);
    return {};
  },
);
const forgeTypeOp = Operation(
  "issue/rename",
  {
    on: Issue,
    input: Schema.Struct({ title: Schema.String }),
    schema: App,
  },
  (op, input) => {
    (op as { set: (e: unknown, f: string, v: unknown) => void }).set(op.self!, ":issue/title", input.title);
    (op as { set: (e: unknown, f: string, v: unknown) => void }).set(op.self!, ":ramose/type", ":user");
    return {};
  },
);

const operations = defineOperations(App, { renameOp, createOp, retagOp, relateOp });

const commitOf = (conn: Connection): AuthorizedWriteInput["commit"] => (tx) =>
  Effect.tryPromise({
    try: async () => {
      const report = await conn.transact(tx, { persistTraitStamps: false });
      return { tempids: report.tempids, dbAfter: report.dbAfter };
    },
    catch: (cause) =>
      cause instanceof OperationRejected
        ? cause
        : new OperationRejected({
            message: cause instanceof Error ? cause.message : String(cause),
            operation: "commit",
          }),
  });

const writeInput = (
  conn: Connection,
  catalogs: DeployedCatalogs,
  token: string,
  ops = operations,
): AuthorizedWriteInput => ({
  authenticate: authenticateToken(token),
  catalogs,
  routeDatabase: database,
  ...proofOf(catalogs),
  currentDb: () => Effect.sync(() => conn.db()),
  operations: ops,
  commit: commitOf(conn),
});

const runWrite = (input: AuthorizedWriteInput, invocation: OperationInvocation) =>
  Effect.runPromise(executeAuthorizedWrite(input, invocation));

const runWriteFail = (input: AuthorizedWriteInput, invocation: OperationInvocation) =>
  Effect.runPromise(Effect.flip(executeAuthorizedWrite(input, invocation)));

const expectOpaque = (error: unknown) => {
  expect(error).toBeInstanceOf(Unauthorized);
  expect((error as { readonly _tag?: unknown })._tag).toBe("Unauthorized");
  expect((error as Error).message).toBe("");
};

const rename = (entity: number, title: string): OperationInvocation => ({
  owner: issueOwner,
  localName: "rename",
  target: "required",
  entity,
  input: { title },
});

const typeFacts = async (db: ReturnType<Connection["db"]>, eid: number) =>
  db.datomsArray(Index.EAVT, { e: eid, a: RAMOSE_TYPE });

const traitFacts = async (db: ReturnType<Connection["db"]>, eid: number) =>
  db.datomsArray(Index.EAVT, { e: eid, a: RAMOSE_TRAIT });

describe("executeAuthorizedWrite", () => {
  test("static create succeeds with a grant and no synthetic target", async () => {
    const world = await seedApp();
    const catalogs = await deployWritePolicy();
    const result = (await runWrite(writeInput(world.conn, catalogs, await signRamose()), {
      owner: issueOwner,
      localName: "create",
      target: "none",
      input: { title: "New", owner: world.aliceEid, workspace: world.ws },
    })) as { id: number };
    expect(typeof result.id).toBe("number");
    const row = await world.conn.db().entity(result.id);
    expect(row?.[":issue/title"]).toBe("New");
    expect(row?.[":issue/source"]).toBe("op");
    expect(row?.[":issue/note"]).toBe("n/a");
    expect(await typeFacts(world.conn.db(), result.id)).toHaveLength(1);
    expect(await traitFacts(world.conn.db(), result.id)).toHaveLength(0);
  });

  test("targeted rename acts only on a visible row", async () => {
    const world = await seedApp();
    const catalogs = await deployWritePolicy();
    const input = writeInput(world.conn, catalogs, await signRamose());
    await runWrite(input, rename(world.i1, "Fixed"));
    expect((await world.conn.db().entity(world.i1))?.[":issue/title"]).toBe("Fixed");
    expectOpaque(await runWriteFail(input, rename(world.i2, "Nope")));
    expect((await world.conn.db().entity(world.i2))?.[":issue/title"]).toBe("Other");
  });

  test("readability alone never authorizes; a grant never exposes a hidden target", async () => {
    const world = await seedApp();
    const readable = await deployReadOnlyPolicy();
    expectOpaque(
      await runWriteFail(writeInput(world.conn, readable, await signRamose()), rename(world.i1, "X")),
    );
    const catalogs = await deployWritePolicy();
    const hidden = await runWriteFail(writeInput(world.conn, catalogs, await signRamose()), rename(world.i2, "X"));
    const missing = await runWriteFail(
      writeInput(world.conn, catalogs, await signRamose()),
      rename(99_999, "X"),
    );
    const wrongType = await runWriteFail(
      writeInput(world.conn, catalogs, await signRamose()),
      rename(world.aliceEid, "X"),
    );
    expectOpaque(hidden);
    expectOpaque(missing);
    expectOpaque(wrongType);
    expect(JSON.stringify(hidden)).toBe(JSON.stringify(missing));
    expect(JSON.stringify(hidden)).toBe(JSON.stringify(wrongType));
  });

  test("trait-owned operations reject incompatible types", async () => {
    const world = await seedApp();
    const catalogs = await deployWritePolicy();
    const input = writeInput(world.conn, catalogs, await signRamose());
    await runWrite(input, {
      owner: taggableOwner,
      localName: "retag",
      target: "required",
      entity: world.i1,
      input: { tag: world.bobEid },
    });
    expectOpaque(
      await runWriteFail(input, {
        owner: taggableOwner,
        localName: "retag",
        target: "required",
        entity: world.aliceEid,
        input: { tag: world.bobEid },
      }),
    );
  });

  test("trait-targeted refs reject invalid targets on the committing basis", async () => {
    const world = await seedApp();
    const catalogs = await deployWritePolicy();
    const input = writeInput(world.conn, catalogs, await signRamose());
    await runWrite(input, {
      owner: issueOwner,
      localName: "relate",
      target: "required",
      entity: world.i1,
      input: { related: world.i2 },
    });
    await expect(
      runWrite(input, {
        owner: issueOwner,
        localName: "relate",
        target: "required",
        entity: world.i1,
        input: { related: world.aliceEid },
      }),
    ).rejects.toBeInstanceOf(OperationRejected);
  });

  test("fixed values cannot be forged; bodies cannot write :ramose/type", async () => {
    const world = await seedApp();
    const catalogs = await deployWritePolicy();
    const input = writeInput(world.conn, catalogs, await signRamose());
    await expect(
      runWrite(input, {
        owner: issueOwner,
        localName: "create",
        target: "none",
        input: { title: "X", owner: world.aliceEid, workspace: world.ws, source: "client" },
      }),
    ).rejects.toBeInstanceOf(OperationRejected);
    const forged = {
      ...operations,
      get: (name: string) => (name === "issue/rename" ? forgeTypeOp : operations.get(name)),
    };
    await expect(
      runWrite(writeInput(world.conn, catalogs, await signRamose(), forged), rename(world.i1, "Y")),
    ).rejects.toBeInstanceOf(OperationRejected);
    expect((await world.conn.db().entity(world.i1))?.[":ramose/type"]).toBe(":issue");
  });

  test("results hide eids that are not visible after commit", async () => {
    const world = await seedApp();
    const catalogs = await deployWritePolicy();
    const result = (await runWrite(writeInput(world.conn, catalogs, await signRamose()), {
      owner: issueOwner,
      localName: "create",
      target: "none",
      input: { title: "Bob-owned", owner: world.bobEid, workspace: world.ws },
    })) as { id: number | null };
    expect(result.id).toBeNull();
  });

  test("catalog-key and unit-hash mismatch deny before write", async () => {
    const world = await seedApp();
    const catalogs = await deployWritePolicy();
    const token = await signRamose();
    const base = writeInput(world.conn, catalogs, token);
    expectOpaque(
      await runWriteFail(
        { ...base, catalogKey: CatalogId.make("other") },
        rename(world.i1, "X"),
      ),
    );
    expect((await world.conn.db().entity(world.i1))?.[":issue/title"]).toBe("Bug");
  });

  test("unknown operations and missing grants are Unauthorized", async () => {
    const world = await seedApp();
    const catalogs = await deployWritePolicy();
    expectOpaque(
      await runWriteFail(writeInput(world.conn, catalogs, await signRamose()), {
        owner: issueOwner,
        localName: "explode",
        target: "none",
        input: {},
      }),
    );
    expectOpaque(
      await runWriteFail(writeInput(world.conn, catalogs, await signRamose({ class: "guest" })), rename(world.i1, "X")),
    );
  });
});
