/**
 * compileReadFilter — deployed read rules as a Db.filter predicate.
 *
 * Real Connection + schemaTx + transact. No mocks or fabricated stores.
 */

import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import {
  EntityId,
  all,
  allow,
  any,
  claim,
  compileReadFilter,
  contains,
  deny,
  eq,
  hasClass,
  hashCatalogSchemaFingerprint,
  installAuthorization,
  lit,
  me,
  not,
  read,
  sealInstalledCatalogUnit,
  subject,
  uniqueCanonicalTypeName,
  type AuthorizationPrincipal,
  type InstalledCatalogUnitV1,
  type PolicyTemplateIR,
} from "../../../src/internal/authorization/index.ts";
import { Connection } from "../../../src/internal/core/conn.ts";
import { datom, Index, ValueTag, type Datom } from "../../../src/internal/core/datom.ts";
import type { Db } from "../../../src/internal/core/db.ts";
import { RAMOSE_TYPE } from "../../../src/internal/core/schema.ts";
import { Entity, Schema, compositionFromSchema, schemaTx, string, type AnySchema } from "../../../src/db/internal.ts";
import {
  App,
  Issue,
  Taggable,
  User,
  Workspace,
  catalog,
  catalogDescriptor,
  compileRules,
  expectOk,
  orgClaim,
  target,
  teamsClaim,
} from "./semantic-fixtures.ts";

const Extra = Entity("extra", { name: string() });

const sealedDescriptor = async () => {
  const base = catalogDescriptor();
  const fingerprint = await Effect.runPromise(hashCatalogSchemaFingerprint(base));
  return { ...base, fingerprint };
};

const installUnit = async (
  template: PolicyTemplateIR,
): Promise<InstalledCatalogUnitV1> => {
  const descriptor = await sealedDescriptor();
  const policy = await Effect.runPromise(
    installAuthorization({
      target: { ...target, schemaFingerprint: descriptor.fingerprint },
      descriptor,
      template,
    }),
  );
  return Effect.runPromise(sealInstalledCatalogUnit(descriptor, policy));
};

const unitFrom = (
  rules: Parameters<typeof compileRules>[0],
  extras?: Parameters<typeof compileRules>[1],
) => installUnit(expectOk(compileRules(rules, extras)));

const seedApp = async (extras: AnySchema = App) => {
  const conn = await Connection.create({
    composition: compositionFromSchema(extras),
  });
  await conn.transact(schemaTx(extras));
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
  const currentDb = conn.db();
  return {
    conn,
    currentDb,
    aliceEid: report.tempids["alice"]!,
    bobEid: report.tempids["bob"]!,
    wsEid: report.tempids["ws"]!,
    i1: report.tempids["i1"]!,
    i2: report.tempids["i2"]!,
    createdT: report.t,
  };
};

const alicePrincipal = (
  aliceEid: number,
  extras: Partial<AuthorizationPrincipal> = {},
): AuthorizationPrincipal => ({
  subject: "alice-sub",
  me: { entity: EntityId.make({ catalog, name: "user" }), eid: aliceEid },
  claims: { org: "acme" },
  classes: ["member"],
  ...extras,
});

const datomOf = async (db: Db, eid: number, ident: string): Promise<Datom> => {
  const attr = db.requireAttr(ident);
  const datom = await db.first(Index.EAVT, { e: eid, a: attr.id });
  if (datom === undefined) throw new Error(`missing ${ident} on ${eid}`);
  return datom;
};

const visibleAppIdents = async (db: Db, eid: number): Promise<string[]> => {
  const datoms = await db.datomsArray(Index.EAVT, { e: eid });
  return datoms
    .map((datom) => db.attr(datom.a)?.ident ?? String(datom.a))
    .filter((ident) => !ident.startsWith(":db/"))
    .sort();
};

const expectVisible = async (db: Db, eid: number, idents: readonly string[]) => {
  expect(await visibleAppIdents(db, eid)).toEqual([...idents].sort());
};

const hasTemplate = (): PolicyTemplateIR => {
  const compiled = expectOk(compileRules([read(Issue).when(contains(Taggable.tags, me))]));
  const rule = compiled.rules[0]!;
  if (rule.expr._tag !== "in" || rule.expr.collection._tag !== "ref") {
    throw new Error("expected compiled contains(Taggable.tags, me)");
  }
  return {
    ...compiled,
    rules: [
      {
        ...rule,
        expr: { _tag: "has", term: rule.expr.collection },
        usesMe: false,
        usesSubject: false,
        usesResource: true,
        traversalDepth: 1,
      },
    ],
  };
};

describe("compileReadFilter expressions", () => {
  test("const true (allow) shows the issue row", async () => {
    const { currentDb, aliceEid, i1 } = await seedApp();
    const pred = compileReadFilter({
      unit: await unitFrom([read(Issue).when(allow)]),
      principal: alicePrincipal(aliceEid),
      currentDb,
    });
    expect(await pred(currentDb, await datomOf(currentDb, i1, ":issue/title"))).toBe(true);
    await expectVisible(currentDb.filter(pred), i1, [
      ":ramose/type",
      ":issue/title",
      ":issue/parent",
    ]);
  });

  test("const false (deny authoring const) hides the issue row", async () => {
    const { currentDb, aliceEid, i1 } = await seedApp();
    const pred = compileReadFilter({
      unit: await unitFrom([read(Issue).when(deny)]),
      principal: alicePrincipal(aliceEid),
      currentDb,
    });
    expect(await pred(currentDb, await datomOf(currentDb, i1, ":issue/title"))).toBe(false);
    expect(await visibleAppIdents(currentDb.filter(pred), i1)).toEqual([]);
  });

  test("hasClass allows only matching principals", async () => {
    const { currentDb, aliceEid, i1 } = await seedApp();
    const unit = await unitFrom([read(Issue).when(hasClass("member"))]);
    const member = compileReadFilter({
      unit,
      principal: alicePrincipal(aliceEid),
      currentDb,
    });
    const guest = compileReadFilter({
      unit,
      principal: alicePrincipal(aliceEid, { classes: [] }),
      currentDb,
    });
    const title = await datomOf(currentDb, i1, ":issue/title");
    expect(await member(currentDb, title)).toBe(true);
    expect(await guest(currentDb, title)).toBe(false);
  });

  test("and (all) requires every clause", async () => {
    const { currentDb, aliceEid, i1 } = await seedApp();
    const pred = compileReadFilter({
      unit: await unitFrom([read(Issue).when(all(hasClass("member"), eq(claim("org"), "acme")))]),
      principal: alicePrincipal(aliceEid),
      currentDb,
    });
    expect(await pred(currentDb, await datomOf(currentDb, i1, ":issue/title"))).toBe(true);
    const denied = compileReadFilter({
      unit: await unitFrom([read(Issue).when(all(hasClass("member"), eq(claim("org"), "other")))]),
      principal: alicePrincipal(aliceEid),
      currentDb,
    });
    expect(await denied(currentDb, await datomOf(currentDb, i1, ":issue/title"))).toBe(false);
  });

  test("or (any) allows if any clause is true", async () => {
    const { currentDb, aliceEid, i1 } = await seedApp();
    const pred = compileReadFilter({
      unit: await unitFrom([read(Issue).when(any(hasClass("admin"), eq(Issue.owner, me)))]),
      principal: alicePrincipal(aliceEid),
      currentDb,
    });
    expect(await pred(currentDb, await datomOf(currentDb, i1, ":issue/title"))).toBe(true);
  });

  test("not inverts a complete value and keeps Incomplete deny-closed", async () => {
    const { currentDb, aliceEid, i1 } = await seedApp();
    const inverted = compileReadFilter({
      unit: await unitFrom([read(Issue).when(not(deny))]),
      principal: alicePrincipal(aliceEid),
      currentDb,
    });
    expect(await inverted(currentDb, await datomOf(currentDb, i1, ":issue/title"))).toBe(true);
    const incomplete = compileReadFilter({
      unit: await unitFrom([read(Issue).when(not(eq(Issue.owner, me)))]),
      principal: { subject: "alice-sub", claims: { org: "acme" }, classes: ["member"] },
      currentDb,
    });
    expect(await incomplete(currentDb, await datomOf(currentDb, i1, ":issue/title"))).toBe(false);
  });

  test("eq with lit, subject, me, claim, and ref", async () => {
    const { currentDb, aliceEid, i1 } = await seedApp();
    const title = await datomOf(currentDb, i1, ":issue/title");
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly rules: Parameters<typeof compileRules>[0];
      readonly extras?: Parameters<typeof compileRules>[1];
      readonly visible: boolean;
    }> = [
      { name: "lit", rules: [read(Issue).when(eq(Issue.title, lit("Bug")))], visible: true },
      { name: "subject", rules: [read(Issue).when(eq(subject, lit("alice-sub")))], visible: true },
      { name: "me", rules: [read(Issue).when(eq(Issue.owner, me))], visible: true },
      { name: "claim", rules: [read(Issue).when(eq(claim("org"), "acme"))], visible: true },
      { name: "ref mismatch", rules: [read(Issue).when(eq(Issue.title, lit("Nope")))], visible: false },
    ];
    for (const scenario of cases) {
      const pred = compileReadFilter({
        unit: await unitFrom(scenario.rules, scenario.extras),
        principal: alicePrincipal(aliceEid),
        currentDb,
      });
      expect(await pred(currentDb, title), scenario.name).toBe(scenario.visible);
    }
  });

  test("has is true when the resource field is present", async () => {
    const { currentDb, aliceEid, i1, i2 } = await seedApp();
    const pred = compileReadFilter({
      unit: await installUnit(hasTemplate()),
      principal: alicePrincipal(aliceEid),
      currentDb,
    });
    expect(await pred(currentDb, await datomOf(currentDb, i1, ":issue/title"))).toBe(true);
    expect(await pred(currentDb, await datomOf(currentDb, i2, ":issue/title"))).toBe(false);
  });

  test("in via contains on a claim array and a card-many field", async () => {
    const { currentDb, aliceEid, i1, wsEid } = await seedApp();
    const claimPred = compileReadFilter({
      unit: await unitFrom([read(Issue).when(contains(claim("teams"), "eng"))], {
        claims: [orgClaim, teamsClaim],
      }),
      principal: alicePrincipal(aliceEid, { claims: { org: "acme", teams: ["eng", "design"] } }),
      currentDb,
    });
    expect(await claimPred(currentDb, await datomOf(currentDb, i1, ":issue/title"))).toBe(true);

    const fieldPred = compileReadFilter({
      unit: await unitFrom([read(Workspace).when(contains(Workspace.members, me))]),
      principal: alicePrincipal(aliceEid),
      currentDb,
    });
    expect(await fieldPred(currentDb, await datomOf(currentDb, wsEid, ":ramose/type"))).toBe(true);
    expect(await fieldPred(currentDb, await datomOf(currentDb, i1, ":issue/title"))).toBe(false);
  });
});

describe("compileReadFilter lattice and fail-closed", () => {
  test("missing :ramose/type denies that entity's datoms", async () => {
    const { conn, currentDb, aliceEid, i1 } = await seedApp();
    const ghost = await conn.transact([{ ":db/id": "ghost", ":db/doc": "no type" }]);
    const pred = compileReadFilter({
      unit: await unitFrom([read(Issue).when(allow)]),
      principal: alicePrincipal(aliceEid),
      currentDb: conn.db(),
    });
    const crafted = { ...(await datomOf(currentDb, i1, ":issue/title")), e: ghost.tempids["ghost"]! };
    expect(await pred(conn.db(), crafted)).toBe(false);
  });

  test("type ident not in catalog denies", async () => {
    const Mixed = Schema({ ...App.entities, extra: Extra });
    const { conn, aliceEid } = await seedApp(Mixed);
    const extra = await conn.transact([
      { ":db/id": "ex", ":ramose/type": ":extra", ":extra/name": "nope" },
    ]);
    const latest = conn.db();
    const pred = compileReadFilter({
      unit: await unitFrom([read(Issue).when(allow)]),
      principal: alicePrincipal(aliceEid),
      currentDb: latest,
    });
    expect(await pred(latest, await datomOf(latest, extra.tempids["ex"]!, ":extra/name"))).toBe(
      false,
    );
  });

  test("malformed type (entity exists without a type fact) denies", async () => {
    const { conn, aliceEid } = await seedApp();
    const ghost = await conn.transact([{ ":db/id": "ghost", ":db/doc": "lonely" }]);
    const latest = conn.db();
    const pred = compileReadFilter({
      unit: await unitFrom([read(Issue).when(allow)]),
      principal: alicePrincipal(aliceEid),
      currentDb: latest,
    });
    const doc = await latest.first(Index.EAVT, {
      e: ghost.tempids["ghost"]!,
      a: latest.requireAttr(":db/doc").id,
    });
    expect(doc).toBeDefined();
    expect(await pred(latest, doc!)).toBe(false);
  });

  test("missing me when a rule uses me denies", async () => {
    const { currentDb, aliceEid, i1 } = await seedApp();
    const pred = compileReadFilter({
      unit: await unitFrom([read(Issue).when(eq(Issue.owner, me))]),
      principal: { subject: "alice-sub", claims: { org: "acme" }, classes: ["member"] },
      currentDb,
    });
    expect(await pred(currentDb, await datomOf(currentDb, i1, ":issue/title"))).toBe(false);
    expect(aliceEid).toBeGreaterThan(0);
  });

  test("explicit deny wins over allow", async () => {
    const { currentDb, aliceEid, i1 } = await seedApp();
    const pred = compileReadFilter({
      unit: await unitFrom([
        read(Issue).when(allow),
        read(Issue).deny(eq(subject, lit("alice-sub"))),
      ]),
      principal: alicePrincipal(aliceEid),
      currentDb,
    });
    expect(await pred(currentDb, await datomOf(currentDb, i1, ":issue/title"))).toBe(false);
  });

  test("incomplete deny does not fail open over an allow", async () => {
    const { currentDb, i1 } = await seedApp();
    const pred = compileReadFilter({
      unit: await unitFrom([read(Issue).when(allow), read(Issue).deny(eq(Issue.owner, me))]),
      principal: { subject: "alice-sub", claims: { org: "acme" }, classes: ["member"] },
      currentDb,
    });
    expect(await pred(currentDb, await datomOf(currentDb, i1, ":issue/title"))).toBe(false);
  });

  test("missing entity rule is deny-by-default", async () => {
    const { currentDb, aliceEid, i1 } = await seedApp();
    const pred = compileReadFilter({
      unit: await unitFrom([read(User).when(allow)]),
      principal: alicePrincipal(aliceEid),
      currentDb,
    });
    expect(await pred(currentDb, await datomOf(currentDb, i1, ":issue/title"))).toBe(false);
    expect(await pred(currentDb, await datomOf(currentDb, aliceEid, ":user/authId"))).toBe(true);
  });

  test("missing trait policy hides trait-owned fields even when the row is readable", async () => {
    const { currentDb, aliceEid, i1 } = await seedApp();
    const pred = compileReadFilter({
      unit: await unitFrom([read(Issue).when(eq(Issue.owner, me)), read(User).when(allow)]),
      principal: alicePrincipal(aliceEid),
      currentDb,
    });
    expect(await pred(currentDb, await datomOf(currentDb, i1, ":issue/title"))).toBe(true);
    expect(await pred(currentDb, await datomOf(currentDb, i1, ":issue/owner"))).toBe(true);
    expect(await pred(currentDb, await datomOf(currentDb, i1, ":taggable/tags"))).toBe(false);
    const visible = await visibleAppIdents(currentDb.filter(pred), i1);
    expect(visible).toContain(":issue/title");
    expect(visible).not.toContain(":taggable/tags");
  });

  test("field rule only narrows — denied field is hidden, other fields stay", async () => {
    const { currentDb, aliceEid, i1 } = await seedApp();
    const pred = compileReadFilter({
      unit: await unitFrom([read(Issue).when(eq(Issue.owner, me)), read(Issue.title).deny(allow)]),
      principal: alicePrincipal(aliceEid),
      currentDb,
    });
    expect(await pred(currentDb, await datomOf(currentDb, i1, ":issue/title"))).toBe(false);
    expect(await pred(currentDb, await datomOf(currentDb, i1, ":ramose/type"))).toBe(true);
    const visible = await visibleAppIdents(currentDb.filter(pred), i1);
    expect(visible).toContain(":ramose/type");
    expect(visible).not.toContain(":issue/title");
  });

  test("trait policy comes from catalog closure, not :ramose/trait datoms", async () => {
    const { currentDb, aliceEid, i1 } = await seedApp();
    const pred = compileReadFilter({
      unit: await unitFrom([
        read(Issue).when(eq(Issue.owner, me)),
        read(Taggable).when(contains(Taggable.tags, me)),
        read(User).when(allow),
      ]),
      principal: alicePrincipal(aliceEid),
      currentDb,
    });
    expect(await pred(currentDb, await datomOf(currentDb, i1, ":taggable/tags"))).toBe(true);
    const visible = await visibleAppIdents(currentDb.filter(pred), i1);
    expect(visible).toContain(":taggable/tags");
  });

  test("REF-1 hides a readable Issue.owner when the user row is unreadable", async () => {
    const { currentDb, aliceEid, i1 } = await seedApp();
    const pred = compileReadFilter({
      unit: await unitFrom([read(Issue).when(eq(Issue.owner, me))]),
      principal: alicePrincipal(aliceEid),
      currentDb,
    });
    expect(await pred(currentDb, await datomOf(currentDb, i1, ":issue/title"))).toBe(true);
    expect(await pred(currentDb, await datomOf(currentDb, i1, ":issue/owner"))).toBe(false);
    expect(await pred(currentDb, await datomOf(currentDb, aliceEid, ":user/authId"))).toBe(false);
  });

  test("current grant governs historical and as-of values (HIST-2)", async () => {
    const { conn, currentDb, aliceEid, bobEid, i1, createdT } = await seedApp();
    const ownerRule = await unitFrom([read(Issue).when(eq(Issue.owner, me))]);
    const whileOwned = compileReadFilter({
      unit: ownerRule,
      principal: alicePrincipal(aliceEid),
      currentDb,
    });
    expect(await whileOwned(currentDb, await datomOf(currentDb, i1, ":issue/title"))).toBe(true);

    await conn.transact([{ ":db/id": i1, ":issue/owner": bobEid }]);
    const after = conn.db();
    const nowDenied = compileReadFilter({
      unit: ownerRule,
      principal: alicePrincipal(aliceEid),
      currentDb: after,
    });
    const historical = after.asOf(createdT);
    const history = after.history();
    const oldTitle = await datomOf(historical, i1, ":issue/title");
    expect(await nowDenied(historical, oldTitle)).toBe(false);
    expect(await nowDenied(history, oldTitle)).toBe(false);
    expect(await visibleAppIdents(historical.filter(nowDenied), i1)).toEqual([]);

    await conn.transact([{ ":db/id": i1, ":issue/owner": aliceEid }]);
    const restored = conn.db();
    const nowAllowed = compileReadFilter({
      unit: ownerRule,
      principal: alicePrincipal(aliceEid),
      currentDb: restored,
    });
    expect(await nowAllowed(restored.asOf(createdT), oldTitle)).toBe(true);
    expect(await visibleAppIdents(restored.asOf(createdT).filter(nowAllowed), i1)).toContain(
      ":issue/title",
    );
  });

  test("query shape cannot change which datoms are hidden", async () => {
    const { currentDb, aliceEid, i1 } = await seedApp();
    const pred = compileReadFilter({
      unit: await unitFrom([read(Issue).when(eq(Issue.owner, me)), read(Issue.title).deny(allow)]),
      principal: alicePrincipal(aliceEid),
      currentDb,
    });
    const filtered = currentDb.filter(pred);
    const titleA = currentDb.requireAttr(":issue/title").id;
    const fromEntity = await filtered.entity(i1);
    const fromEavt = await filtered.datomsArray(Index.EAVT, { e: i1 });
    const fromAevt = await filtered.datomsArray(Index.AEVT, { a: titleA });
    expect(fromEntity?.[":issue/title"]).toBeUndefined();
    expect(fromEavt.some((datom) => datom.a === titleA)).toBe(false);
    expect(fromAevt.filter((datom) => datom.e === i1)).toEqual([]);
    expect(fromEntity?.[":ramose/type"]).toBe(":issue");
  });
});

describe("compileReadFilter requested-db classification", () => {
  test("uniqueCanonicalTypeName fails closed on zero, malformed, or conflicting values", () => {
    const issue = datom(1, RAMOSE_TYPE, ValueTag.Str, ":issue", 1, true);
    const retract = datom(1, RAMOSE_TYPE, ValueTag.Str, ":issue", 2, false);
    const note = datom(1, RAMOSE_TYPE, ValueTag.Str, ":note", 3, true);
    expect(uniqueCanonicalTypeName([])).toBeUndefined();
    expect(uniqueCanonicalTypeName([issue])).toBe("issue");
    expect(uniqueCanonicalTypeName([issue, retract])).toBe("issue");
    expect(uniqueCanonicalTypeName([issue, note])).toBeUndefined();
    expect(uniqueCanonicalTypeName([datom(1, RAMOSE_TYPE, ValueTag.Str, ":issue/title", 1)])).toBeUndefined();
    expect(uniqueCanonicalTypeName([datom(1, RAMOSE_TYPE, ValueTag.Long, 1, 1)])).toBeUndefined();
    expect(uniqueCanonicalTypeName([datom(1, RAMOSE_TYPE, ValueTag.Str, ":", 1)])).toBeUndefined();
  });

  test("a currently readable entity remains readable through asOf where its type exists", async () => {
    const { currentDb, aliceEid, i1, createdT } = await seedApp();
    const pred = compileReadFilter({
      unit: await unitFrom([read(Issue).when(allow)]),
      principal: alicePrincipal(aliceEid),
      currentDb,
    });
    const title = await datomOf(currentDb, i1, ":issue/title");
    const asOf = currentDb.asOf(createdT);
    expect(await pred(currentDb, title)).toBe(true);
    expect(await pred(asOf, title)).toBe(true);
    await expectVisible(asOf.filter(pred), i1, [
      ":ramose/type",
      ":issue/title",
      ":issue/parent",
    ]);
  });

  test("after retractEntity, history and bounded history recover type; current denies", async () => {
    const { conn, currentDb, aliceEid, i1, i2, createdT } = await seedApp();
    const title = await datomOf(currentDb, i1, ":issue/title");
    const retracted = await conn.transact([
      [":db/retractEntity", i2],
      [":db/retractEntity", i1],
    ]);
    const after = conn.db();
    const pred = compileReadFilter({
      unit: await unitFrom([read(Issue).when(allow)]),
      principal: alicePrincipal(aliceEid),
      currentDb: after,
    });
    const asOf = after.asOf(createdT);
    const history = after.history();
    const boundedFromAsOf = asOf.history();
    const boundedFromHistory = history.asOf(createdT);
    const boundedThroughDelete = after.history().asOf(retracted.t);

    expect(await pred(after, title)).toBe(false);
    expect(await pred(asOf, title)).toBe(true);
    expect(await pred(history, title)).toBe(true);
    expect(await pred(boundedFromAsOf, title)).toBe(true);
    expect(await pred(boundedFromHistory, title)).toBe(true);
    expect(await pred(boundedThroughDelete, title)).toBe(true);
    expect(await visibleAppIdents(after.filter(pred), i1)).toEqual([]);
    await expectVisible(asOf.filter(pred), i1, [
      ":ramose/type",
      ":issue/title",
      ":issue/parent",
    ]);
    expect(await visibleAppIdents(history.filter(pred), i1)).toContain(":issue/title");
    expect(await visibleAppIdents(boundedFromAsOf.filter(pred), i1)).toContain(":issue/title");
  });

  test("current grants still govern historical datoms after retractEntity", async () => {
    const { conn, currentDb, aliceEid, i1, i2, createdT } = await seedApp();
    const title = await datomOf(currentDb, i1, ":issue/title");
    await conn.transact([
      [":db/retractEntity", i2],
      [":db/retractEntity", i1],
    ]);
    const after = conn.db();
    const ownerPred = compileReadFilter({
      unit: await unitFrom([read(Issue).when(eq(Issue.owner, me))]),
      principal: alicePrincipal(aliceEid),
      currentDb: after,
    });
    expect(await ownerPred(after.asOf(createdT), title)).toBe(false);
    expect(await ownerPred(after.history(), title)).toBe(false);
    expect(await ownerPred(after.asOf(createdT).history(), title)).toBe(false);
    expect(await visibleAppIdents(after.history().filter(ownerPred), i1)).toEqual([]);
  });
});
