import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as S from "effect/Schema";
import { Entity, EntityId, Field, Ref, Schema, string } from "../../../src/db/index.ts";
import { schemaTx } from "../../../src/db/internal.ts";
import { Connection } from "../../../src/internal/core/conn.ts";
import { restoreEngineTypeAssertions } from "../../../src/internal/core/tx-provenance.ts";
import { authorizeChangeset, changesetDiff, prepareChangeset } from "../../../src/internal/authorization/changesets.ts";
import {
  assembleCatalogDefinitions, deployCatalogDefinitions, CatalogId, DatabaseId, DigestHex,
  type AuthenticatedCaller, type OperationInvocation,
} from "../../../src/internal/authorization/index.ts";

const Item = Entity("proposalItem", { name: Field.unique(string(), "strict"), secret: string(), related: Field(Ref.self, { optional: true }) }, {
  operations: (Operation) => ({
    rename: Operation({ input: S.Struct({ name: S.String }), output: S.Struct({}),
      run(op, input) { op.self.set(Item.name, input.name); return {}; } }),
    create: Operation({ self: false, input: S.Struct({ name: S.String }), output: S.Struct({ id: EntityId }),
      run(op, input) { return { id: op.create({ name: input.name, secret: "private" }) }; } }),
    secret: Operation({ input: S.Struct({ secret: S.String }), output: S.Struct({}),
      run(op, input) { op.self.set(Item.secret, input.secret); return {}; } }),
    attachNew: Operation({ input: S.Struct({ name: S.String }), output: S.Struct({}),
      run(op, input) {
        const related = op.put(Item, { name: input.name, secret: "new secret" });
        op.self.set(Item.related, related);
        return {};
      } }),
    inspectContext: Operation({ input: S.Struct({}), output: S.Struct({}),
      run(op) { if ("effect" in op || "env" in op) throw new Error("transaction exposes effects"); return {}; } }),
  }),
});
const App = Schema("changeset-test", { proposalItem: Item });
App.applyPolicy({ roles: ["member", "reader"] }, ({ policy, session }) => {
  policy.proposalItem.read.where(session.hasRole("member"));
  policy.proposalItem.read.where(session.hasRole("reader"));
  policy.proposalItem.fields.secret.read.where(session.hasRole("reader"));
  policy.proposalItem.fields.secret.read.where((row) => row.name.eq("After"));
  policy.proposalItem.operations.rename.where(session.hasRole("member"));
  policy.proposalItem.operations.create.where(session.hasRole("member"));
  policy.proposalItem.operations.secret.where(session.hasRole("member"));
  policy.proposalItem.operations.attachNew.where(session.hasRole("member"));
  policy.proposalItem.operations.inspectContext.where(session.hasRole("member"));
});

const caller: AuthenticatedCaller = { claims: { sub: "ada" }, classes: ["member"], exp: 2_000_000_000 };
const world = async () => {
  const key = CatalogId.make(App.key);
  const database = DatabaseId.make("changesets");
  const definitions = await Effect.runPromise(assembleCatalogDefinitions({ root: App, artifactHash: DigestHex.make("3".repeat(64)) }));
  const installed = Result.getOrThrow(definitions.require(key));
  const deployed = Result.getOrThrow(deployCatalogDefinitions(definitions, [{ database, catalogKey: key }]));
  const conn = await Connection.create({ composition: installed.composition });
  await conn.transact(schemaTx(App));
  const seed = [{ ":db/id": "item", ":ramose/type": ":proposalItem", ":proposalItem/name": "Before", ":proposalItem/secret": "hidden" }];
  restoreEngineTypeAssertions(seed);
  const report = await conn.transact(seed);
  const runtime = { catalogs: deployed, now: () => 1_800_000_000_000 };
  const operation = (localName: string, input: unknown): OperationInvocation => ({
    database, catalogKey: key, unitHash: installed.unitHash, caller,
    owner: { kind: "entity", name: "proposalItem" }, localName, input,
    operationVersion: installed.unit.catalog.operations.find((op) => op.id.localName === localName)!.version,
    ...(localName === "create" ? {} : { target: report.tempids.item! }),
  });
  return { conn, runtime, operation, eid: report.tempids.item! };
};

describe("reviewable changesets", () => {
  test("isolates multiple operations and folds intermediate values into one version", async () => {
    const w = await world();
    const basis = w.conn.t;
    const stored = await prepareChangeset(w.conn, w.runtime, { id: "draft", title: "Rename twice", operations: [
      w.operation("rename", { name: "Intermediate" }), w.operation("rename", { name: "After" }),
    ] }, caller);
    expect(w.conn.t).toBe(basis);
    expect((await w.conn.db().entity(w.eid))?.[":proposalItem/name"]).toBe("Before");
    expect(stored.datoms.every((d) => d.t === basis + 1)).toBe(true);
    expect(stored.datoms.some((d) => d.v === "Intermediate")).toBe(false);
    await authorizeChangeset(w.conn, w.runtime, stored, caller);
    w.conn.applyDatoms(stored.datoms);
    expect(w.conn.t).toBe(basis + 1);
    expect((await w.conn.db().entity(w.eid))?.[":proposalItem/name"]).toBe("After");
  });

  test("failure in a later operation leaves the live database and allocation cursor untouched", async () => {
    const w = await world();
    const basis = w.conn.t;
    const next = w.conn.nextEntityId;
    await expect(prepareChangeset(w.conn, w.runtime, { id: "draft", title: "Collision", operations: [
      w.operation("create", { name: "New" }), w.operation("create", { name: "New" }),
    ] }, caller)).rejects.toBeDefined();
    expect(w.conn.t).toBe(basis);
    expect(w.conn.nextEntityId).toBe(next);
  });

  test("checks current grants, subject, expiration and base version before applying", async () => {
    const w = await world();
    const stored = await prepareChangeset(w.conn, w.runtime, { id: "draft", title: "Rename", operations: [w.operation("rename", { name: "After" })] }, caller);
    await expect(authorizeChangeset(w.conn, w.runtime, stored, { ...caller, classes: ["reader"] })).rejects.toBeDefined();
    await expect(authorizeChangeset(w.conn, w.runtime, stored, { ...caller, claims: { sub: "other" } })).rejects.toBeDefined();
    await expect(authorizeChangeset(w.conn, { ...w.runtime, now: () => stored.expiresAt }, stored, caller)).rejects.toMatchObject({ code: "changeset_expired" });
    await w.conn.transact([]);
    await expect(authorizeChangeset(w.conn, w.runtime, stored, caller)).rejects.toMatchObject({ code: "changeset_stale" });
  });

  test("every operation is draftable and its context contains only transaction capabilities", async () => {
    const w = await world();
    const draft = await prepareChangeset(w.conn, w.runtime, { id: "pure", title: "Pure transaction", operations: [w.operation("inspectContext", {})] }, caller);
    expect(draft.status).toBe("draft");
  });

  test("existing readable records can reference new draft records without widening existing access", async () => {
    const w = await world();
    const stored = await prepareChangeset(w.conn, w.runtime, { id: "relationship", title: "Create and attach", operations: [w.operation("attachNew", { name: "Related" })] }, caller);
    const facts = await changesetDiff(w.conn, w.runtime, stored, caller);
    const reference = facts.find((fact) => fact.field === ":proposalItem/related");
    expect(reference).toMatchObject({ entity: w.eid, added: true, reference: true });
    expect(facts.some((fact) => fact.entity === reference!.value && fact.value === "Related")).toBe(true);
    expect(JSON.stringify(facts)).not.toContain("new secret");
  });

  test("a retained preview loses access when live field permissions are revoked", async () => {
    const w = await world();
    await w.conn.transact([[":db/add", w.eid, ":proposalItem/name", "After"]]);
    const base = w.conn.fork();
    const stored = await prepareChangeset(base, w.runtime, { id: "retained", title: "Update", operations: [w.operation("secret", { secret: "reviewed" })] }, caller);
    expect((await changesetDiff(base, w.runtime, stored, caller)).some((fact) => fact.value === "reviewed")).toBe(true);
    await w.conn.transact([[":db/add", w.eid, ":proposalItem/name", "Before"]]);
    expect(await changesetDiff(base, w.runtime, stored, caller, w.conn)).toEqual([]);
  });

  test("draft changes cannot widen access to existing hidden facts", async () => {
    const w = await world();
    const stored = await prepareChangeset(w.conn, w.runtime, { id: "draft", title: "Update", operations: [
      w.operation("rename", { name: "After" }), w.operation("secret", { secret: "still hidden" }),
    ] }, caller);
    const diff = await changesetDiff(w.conn, w.runtime, stored, caller);
    expect(diff.map((d) => d.field)).toEqual([":proposalItem/name", ":proposalItem/name"]);
    expect(JSON.stringify(diff)).not.toContain("hidden");
  });
});
