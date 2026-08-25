import { beforeEach, describe, expect, test } from "bun:test";
import { Connection } from "../../../src/internal/core/conn.ts";
import { Index, ValueTag } from "../../../src/internal/core/datom.ts";
import type { Db } from "../../../src/internal/core/db.ts";
import {
  type CompiledPolicy,
  type Principal,
  PolicyAst as A,
  PolicyBudgetError,
  PolicyMemo,
  PolicyParseError,
  allowsOp,
  checkTx,
  filterDb,
  isSchemaTx,
  isSuperuser,
  parsePolicy,
  policyView,
  presetOps,
} from "../../../src/internal/core/policy/index.ts";
import { query } from "../../../src/internal/core/query/engine.ts";
import { pull } from "../../../src/internal/core/query/pull.ts";
import { type TelemetryEvent, setTelemetrySink } from "../../../src/internal/core/telemetry.ts";

const SCHEMA = [
  { ":db/ident": ":user/sub", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/unique": ":db.unique/identity", ":db/optional": true },
  { ":db/ident": ":user/name", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/optional": true },
  { ":db/ident": ":org/name", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/optional": true },
  { ":db/ident": ":org/members", ":db/valueType": ":db.type/ref", ":db/cardinality": ":db.cardinality/many" },
  { ":db/ident": ":project/org", ":db/valueType": ":db.type/ref", ":db/cardinality": ":db.cardinality/one", ":db/optional": true },
  { ":db/ident": ":project/name", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/index": true, ":db/optional": true },
  { ":db/ident": ":doc/title", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/index": true, ":db/optional": true },
  { ":db/ident": ":doc/owner", ":db/valueType": ":db.type/ref", ":db/cardinality": ":db.cardinality/one", ":db/optional": true },
  { ":db/ident": ":doc/project", ":db/valueType": ":db.type/ref", ":db/cardinality": ":db.cardinality/one", ":db/optional": true },
  { ":db/ident": ":doc/audit", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/optional": true },
  { ":db/ident": ":secret/code", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/optional": true },
];

/** doc → project → org → members ∋ principal */
const inOrg = A.ref(":doc/project", A.ref(":project/org", A.eq(":org/members", A.principal)));

const POLICY_JSON = {
  version: 1,
  principal: ":user/sub",
  classes: ["anonymous", "member", "admin"],
  superuser: "admin",
  attrs: { ":doc/audit": { read: [A.allow(A.class("admin"))] } },
  ns: {
    doc: {
      read: [A.allow(A.or(A.eq(":doc/owner", A.principal), inOrg))],
      create: [A.allow(inOrg)],
      add: [A.allow(A.eq(":doc/owner", A.principal))],
      retract: [A.allow(A.eq(":doc/owner", A.principal))],
      retractEntity: [A.allow(A.eq(":doc/owner", A.principal))],
    },
    project: { read: [A.allow(A.ref(":project/org", A.eq(":org/members", A.principal)))] },
    org: { read: [A.allow(A.eq(":org/members", A.principal))] },
    user: { read: [A.allow(A.eq(":user/sub", A.claim("sub")))] },
  },
  preset: { ":doc/owner": A.principal },
};

let conn: Connection;
let db: Db;
let ids: Record<string, number>;
let policy: CompiledPolicy;

const user = (sub: string, eid: number | undefined, cls = "member"): Principal => ({
  kind: "user",
  class: cls,
  sub,
  eid,
  claims: { sub, iss: "https://auth.test", aud: "ramose:peer:test", exp: 2 ** 31, attrs: { org: "org_1" } },
  db: "acme",
});

beforeEach(async () => {
  conn = await Connection.create({ now: () => 1_700_000_000_000 });
  await conn.transact(SCHEMA);
  const rep = await conn.transact([
    { ":db/id": "alice", ":user/sub": "u_alice", ":user/name": "Alice" },
    { ":db/id": "bob", ":user/sub": "u_bob", ":user/name": "Bob" },
    { ":db/id": "org1", ":org/name": "Acme", ":org/members": ["alice"] },
    { ":db/id": "org2", ":org/name": "Other", ":org/members": ["bob"] },
    { ":db/id": "p1", ":project/name": "P1", ":project/org": "org1" },
    { ":db/id": "p2", ":project/name": "P2", ":project/org": "org2" },
    { ":db/id": "d1", ":doc/title": "D1", ":doc/owner": "alice", ":doc/project": "p1", ":doc/audit": "who" },
    { ":db/id": "d2", ":doc/title": "D2", ":doc/owner": "bob", ":doc/project": "p2" },
    { ":db/id": "s1", ":secret/code": "hunter2" },
  ]);
  ids = rep.tempids;
  db = conn.db();
  policy = parsePolicy(POLICY_JSON);
});

const alice = () => user("u_alice", ids.alice);
const bob = () => user("u_bob", ids.bob);
const anon = (): Principal => ({ kind: "anonymous", class: "anonymous", claims: {}, db: "acme" });
const admin = () => user("u_alice", ids.alice, "admin");
const viewFor = (p: Principal, base: Db = db) => filterDb(base, db, policy, p);

const identsOf = async (d: Db, e: number): Promise<string[]> =>
  (await d.datomsArray(Index.EAVT, { e })).map((x) => d.attr(x.a)!.ident).sort();

// ---------------------------------------------------------------------------

describe("parsePolicy", () => {
  test("accepts the compiled shape and normalizes preset shorthand", () => {
    const p = parsePolicy({ ...POLICY_JSON, preset: { ":doc/owner": ["attrs", "org"] } });
    expect(p.version).toBe(1);
    expect(p.principal).toBe(":user/sub");
    expect(p.preset[":doc/owner"]).toEqual({ _tag: "claim", path: ["attrs", "org"] });
    expect(p.ns!.doc.read).toHaveLength(1);
  });

  test("rejects malformed policies with a descriptive error", () => {
    const bad = (patch: Record<string, unknown>, re: RegExp) => {
      expect(() => parsePolicy({ ...POLICY_JSON, ...patch })).toThrow(re);
      expect(() => parsePolicy({ ...POLICY_JSON, ...patch })).toThrow(PolicyParseError);
    };
    expect(() => parsePolicy(null)).toThrow(/expected an object/);
    expect(() => parsePolicy([])).toThrow(/expected an object/);
    bad({ version: 3 }, /version: expected 1 or 2, got 3/);
    bad({ version: undefined }, /version/);
    bad({ principal: "user/sub" }, /principal: expected an attribute ident/);
    bad({ classes: [] }, /classes/);
    bad({ classes: ["a", "a"] }, /duplicate class/);
    bad({ attrs: { "doc/audit": {} } }, /attrs/);
    bad({ attrs: { ":doc/audit": { peek: [] } } }, /unknown op/);
    bad({ attrs: { ":doc/audit": { read: [{ _tag: "maybe", expr: A.const(true) }] } } }, /expected "allow" or "deny"/);
    bad({ attrs: { ":doc/audit": { read: [A.allow({ _tag: "nope" } as never)] } } }, /unknown expr _tag/);
    bad({ attrs: { ":doc/audit": { read: [A.allow(A.class("ghost"))] } } }, /not a declared class/);
    bad({ ns: { ":doc": {} } }, /bare namespace prefix/);
    bad({ preset: { ":doc/owner": { _tag: "wat" } } }, /unknown operand _tag/);
    bad({ superuser: "ghost" }, /superuser: "ghost" is not a declared class/);
    bad({ schemaClasses: [] }, /schemaClasses/);
    bad({ schemaClasses: ["ghost"] }, /schemaClasses: "ghost" is not a declared class/);
  });

  test("superuser and schemaClasses are optional; schemaClasses defaults to [superuser]", () => {
    const named = parsePolicy({ ...POLICY_JSON, superuser: "admin" });
    expect(named.superuser).toBe("admin");
    expect(named.schemaClasses).toEqual(["admin"]);
    const split = parsePolicy({
      ...POLICY_JSON,
      superuser: "admin",
      schemaClasses: ["member"],
    });
    expect(split.superuser).toBe("admin");
    expect(split.schemaClasses).toEqual(["member"]);
    const none = parsePolicy({ ...POLICY_JSON, superuser: undefined });
    expect(none.superuser).toBeUndefined();
    expect(none.schemaClasses).toBeUndefined();
  });

  test("accepts a version-2 fragment policy", () => {
    const p = parsePolicy({
      version: 2,
      principal: ":user/sub",
      classes: ["member", "admin"],
      superuser: "admin",
      attrs: { ":doc/audit": { read: [{ _tag: "allow", class: ["admin"], rule: true }] } },
      ns: {
        doc: {
          read: [{ _tag: "allow", rule: true }],
          add: [{ _tag: "allow", class: ["member"], rule: "policy/doc/add/0" }],
        },
      },
      preset: { ":doc/owner": { _tag: "principal" } },
      rules: [[["policy/doc/add/0", "?me", "?e"], ["?e", ":doc/owner", "?me"]]],
    });
    expect(p.version).toBe(2);
    expect(p.ns!.doc.add).toEqual([{ _tag: "allow", class: ["member"], rule: "policy/doc/add/0" }]);
    expect(p.rules).toHaveLength(1);
  });

  test("rejects a version-2 arm that names a missing rule", () => {
    expect(() =>
      parsePolicy({
        version: 2,
        principal: ":user/sub",
        classes: ["member"],
        attrs: {},
        ns: { doc: { read: [{ _tag: "allow", rule: "missing" }] } },
        preset: {},
      }),
    ).toThrow(/not in rules/);
  });

  test("rejects ref nesting past depth 3", () => {
    const d3 = A.ref(":doc/project", A.ref(":project/org", A.ref(":org/members", A.eq(":user/sub", A.claim("sub")))));
    expect(() => parsePolicy({ ...POLICY_JSON, attrs: { ":doc/title": { read: [A.allow(d3)] } } })).not.toThrow();
    const d4 = A.ref(":doc/project", d3);
    expect(() => parsePolicy({ ...POLICY_JSON, attrs: { ":doc/title": { read: [A.allow(d4)] } } })).toThrow(
      /ref nesting exceeds depth 3/,
    );
  });
});

// ---------------------------------------------------------------------------

describe("rule combination", () => {
  test("deny by default: a schema attribute the policy never mentions", async () => {
    expect(await identsOf(viewFor(alice()), ids.s1)).toEqual([]);
    expect(await identsOf(viewFor(admin()), ids.s1)).toEqual([":secret/code"]);
  });

  test("allow arms OR: owner or org membership", async () => {
    // alice owns d1 and is in its org
    expect(await identsOf(viewFor(alice()), ids.d1)).toContain(":doc/title");
    // bob owns d2; alice is in neither d2's org nor its owner
    expect(await identsOf(viewFor(alice()), ids.d2)).toEqual([]);
    expect(await identsOf(viewFor(bob()), ids.d2)).toContain(":doc/title");
    // ownership alone is enough: a doc with no project
    const rep = await conn.transact([{ ":db/id": "d3", ":doc/title": "D3", ":doc/owner": ids.bob }]);
    const d = conn.db();
    expect(await identsOf(filterDb(d, d, policy, bob()), rep.tempids.d3)).toEqual([":doc/owner", ":doc/title"]);
  });

  test("any deny arm wins over an allow arm", async () => {
    const p = parsePolicy({
      ...POLICY_JSON,
      ns: { ...POLICY_JSON.ns, doc: { read: [A.allow(A.const(true)), A.deny(A.eq(":doc/owner", A.principal))] } },
    });
    expect(await identsOf(filterDb(db, db, p, alice()), ids.d1)).toEqual([]); // alice owns d1 → denied
    expect(await identsOf(filterDb(db, db, p, alice()), ids.d2)).toContain(":doc/title");
  });

  test("an attribute rule only narrows its namespace rule", async () => {
    // :doc/audit needs class admin AND the doc namespace read rule
    expect(await identsOf(viewFor(alice()), ids.d1)).toEqual([":doc/owner", ":doc/project", ":doc/title"]);
    // a non-admin class named by the attr rule still needs the ns rule to pass
    const p = parsePolicy({ ...POLICY_JSON, attrs: { ":doc/audit": { read: [A.allow(A.class("member"))] } } });
    expect(await identsOf(filterDb(db, db, p, alice()), ids.d1)).toContain(":doc/audit");
    expect(await identsOf(filterDb(db, db, p, bob()), ids.d1)).toEqual([]); // ns rule fails for bob
  });

  test("eq on a cardinality-many attribute is membership", async () => {
    expect(await identsOf(viewFor(alice()), ids.org1)).toEqual([":org/members", ":org/name"]);
    expect(await identsOf(viewFor(alice()), ids.org2)).toEqual([]);
    expect(await identsOf(viewFor(bob()), ids.org2)).toEqual([":org/members", ":org/name"]);
  });

  test("ref chains: doc → project → org → members ∋ principal", async () => {
    // alice does not own d1's sibling but reaches it through the org
    const rep = await conn.transact([{ ":db/id": "d4", ":doc/title": "D4", ":doc/owner": ids.bob, ":doc/project": ids.p1 }]);
    const d = conn.db();
    expect(await identsOf(filterDb(d, d, policy, alice()), rep.tempids.d4)).toContain(":doc/title");
    expect(await identsOf(filterDb(d, d, policy, bob()), rep.tempids.d4)).toContain(":doc/title"); // owner
    // one hop: project read
    expect(await identsOf(viewFor(alice()), ids.p1)).toContain(":project/name");
    expect(await identsOf(viewFor(alice()), ids.p2)).toEqual([]);
  });

  test("class() folds to a constant and needs no data", async () => {
    const p = parsePolicy({ ...POLICY_JSON, ns: { ...POLICY_JSON.ns, secret: { read: [A.allow(A.class("member"))] } } });
    expect(await identsOf(filterDb(db, db, p, alice()), ids.s1)).toEqual([":secret/code"]);
    expect(await identsOf(filterDb(db, db, p, anon()), ids.s1)).toEqual([]);
  });

  test("a policy ident absent from the schema folds to false and is reported once", async () => {
    const p = parsePolicy({ ...POLICY_JSON, ns: { ...POLICY_JSON.ns, secret: { read: [A.allow(A.eq(":ghost/attr", A.principal))] } } });
    const v = filterDb(db, db, p, alice());
    expect(await identsOf(v, ids.s1)).toEqual([]);
    await identsOf(v, ids.s1);
    const errs = policyView(v)!.memo.errors;
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatchObject({ _tag: "PolicyError", reason: "unknown-attr", attr: ":ghost/attr" });
  });

  test("superuser bypasses the filter; a class named admin does not", async () => {
    expect(filterDb(db, db, policy, admin())).toBe(db);
    expect(isSuperuser(admin(), policy)).toBe(true);
    expect(isSuperuser(alice(), policy)).toBe(false);
    expect(isSuperuser({ ...alice(), kind: "service" }, policy)).toBe(false); // a service token is not data-plane superuser
    const noBypass = parsePolicy({ ...POLICY_JSON, superuser: undefined });
    expect(isSuperuser(admin(), noBypass)).toBe(false);
    expect(filterDb(db, db, noBypass, admin())).not.toBe(db);
  });
});

// ---------------------------------------------------------------------------

describe("filtered Db", () => {
  test("datoms / datomsArray / first / seekMany drop unreadable datoms", async () => {
    const v = viewFor(alice());
    const audit = db.attr(":doc/audit")!.id;
    expect(await v.first(Index.EAVT, { e: ids.d1, a: audit })).toBeUndefined();
    expect(await v.first(Index.EAVT, { e: ids.d1, a: db.attr(":doc/title")!.id })).toBeDefined();
    expect(await v.datomsArray(Index.AEVT, { a: audit })).toEqual([]);
    const [t1, t2] = await v.seekMany(Index.EAVT, [{ e: ids.d1 }, { e: ids.d2 }]);
    expect(t1.length).toBeGreaterThan(0);
    expect(t2).toEqual([]);
    // AVET lookups are filtered too
    expect(await v.first(Index.AVET, { a: db.attr(":doc/title")!.id, vt: ValueTag.Str, v: "D2" })).toBeUndefined();
    expect(await v.entity(ids.d2)).toBeUndefined();
    expect(await v.exists(ids.d2)).toBe(false);
  });

  test("schema and tx datoms stay readable", async () => {
    const v = viewFor(alice());
    expect((await v.datomsArray(Index.EAVT, { e: db.attr(":doc/audit")!.id })).length).toBeGreaterThan(0);
    expect(v.attr(":doc/audit")).toBeDefined();
  });

  test("q is filtered, including a variable-attribute clause", async () => {
    const v = viewFor(alice());
    const titles = await query(v, { find: ["?t"], where: [["?e", ":doc/title", "?t"]] });
    expect(titles.flat().sort()).toEqual(["D1"]);
    const anyAttr = await query(v, { find: ["?a", "?val"], where: [["?e", "?a", "?val"], ["?e", ":doc/title", "?t"]] });
    const attrs = new Set(anyAttr.map((r: unknown[]) => r[0]));
    expect(attrs.has(db.attr(":doc/audit")!.id)).toBe(false);
    expect(attrs.has(db.attr(":doc/title")!.id)).toBe(true);
    // bob sees only his own doc through the same query
    const bobTitles = await query(viewFor(bob()), { find: ["?t"], where: [["?e", ":doc/title", "?t"]] });
    expect(bobTitles.flat().sort()).toEqual(["D2"]);
  });

  test("pull hides a masked attribute but keeps the rest", async () => {
    const v = viewFor(alice());
    const r = await pull(v, ids.d1, [":doc/title", ":doc/audit", ":doc/owner"]);
    expect(r![":doc/title"]).toBe("D1");
    expect(r![":doc/audit"]).toBeUndefined();
    expect(await pull(v, ids.d2, [":doc/title"])).toBeNull();
    expect((await pull(viewFor(admin()), ids.d1, [":doc/audit"]))![":doc/audit"]).toBe("who");
  });

  test("pull inside :find is filtered — same db, so no pull-specific code", async () => {
    const rows = await query(viewFor(alice()), `[:find (pull ?e [:doc/title :doc/audit]) :where [?e :doc/title]]`);
    expect(rows.map((r: unknown[]) => (r[0] as Record<string, unknown>)[":doc/title"])).toEqual(["D1"]);
    expect((rows[0] as unknown[])[0]).toEqual({ ":doc/title": "D1" }); // :doc/audit redacted, the row is not dropped
    const asAdmin = await query(viewFor(admin()), `[:find (pull ?e [:doc/title :doc/audit]) :where [?e :doc/title]]`);
    expect(asAdmin.map((r: unknown[]) => (r[0] as Record<string, unknown>)[":doc/audit"]).filter(Boolean)).toEqual(["who"]);
  });

  test("estimate is not filtered", async () => {
    const v = viewFor(alice());
    const a = db.attr(":doc/audit")!.id;
    expect(await v.estimate(Index.AEVT, { a })).toBe(await db.estimate(Index.AEVT, { a }));
    expect(await v.estimate(Index.AEVT, { a })).toBeGreaterThan(0);
  });

  test("asOf and history stay filtered and are judged by the current rule view", async () => {
    const v0 = viewFor(alice());
    expect(await identsOf(v0, ids.p1)).toContain(":project/name");
    const before = conn.t;
    // revoke alice's membership
    await conn.transact([[":db/retract", ids.org1, ":org/members", ids.alice]]);
    const cur = conn.db();
    const v = filterDb(cur, cur, policy, alice());
    expect(await identsOf(v, ids.p1)).toEqual([]);
    // the grant existed at `before`, but the rule view is always current
    expect(await identsOf(v.asOf(before), ids.p1)).toEqual([]);
    expect(await identsOf(v.history(), ids.p1)).toEqual([]);
    // alice still owns d1, so d1 stays visible in every view
    expect(await identsOf(v.asOf(before), ids.d1)).toContain(":doc/title");
    expect((await v.history().datomsArray(Index.EAVT, { e: ids.d1 })).length).toBeGreaterThan(0);
    // and history never leaks the masked attribute
    expect((await v.history().datomsArray(Index.EAVT, { e: ids.d1, a: db.attr(":doc/audit")!.id }))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("isSchemaTx", () => {
  const ensure = {
    ":db/ident": ":doc/title",
    ":db/valueType": ":db.type/string",
    ":db/cardinality": ":db.cardinality/one",
    ":db/optional": true,
  };

  test("a map-form ensure of :db/* scalars is schema", () => {
    expect(isSchemaTx([ensure])).toBe(true);
    expect(isSchemaTx([ensure, { ...ensure, ":db/ident": ":doc/audit", ":db/index": true }])).toBe(true);
  });

  test("empty, vector, extra app keys, nested maps, and :db/id are not schema", () => {
    expect(isSchemaTx([])).toBe(false);
    expect(isSchemaTx([[":db/add", 1, ":doc/title", "x"]])).toBe(false);
    expect(isSchemaTx([{ ...ensure, ":doc/title": "PWNED" }])).toBe(false);
    expect(isSchemaTx([{ ...ensure, ":doc/owner": { ":db/id": 1, ":doc/title": "PWNED" } }])).toBe(false);
    expect(isSchemaTx([{ ...ensure, ":db/id": 42 }])).toBe(false);
    expect(isSchemaTx([{ ...ensure, ":db/id": "attr" }])).toBe(false);
  });
});

describe("checkTx", () => {
  const check = (ops: unknown[], p: Principal, d: Db = db) => checkTx(ops, d, policy, p);

  test("an existence ping is not a policy verb (existing no-op, missing tx/missing-entity)", async () => {
    const ping = (e: unknown) => [[":db/update", e]] as unknown[];
    // Non-admin, including a principal who cannot `add` this row.
    expect((await check(ping(ids.d1), alice())).ok).toBe(true);
    expect((await check(ping(ids.d1), bob())).ok).toBe(true);
    await expect(check(ping(999_999), alice())).rejects.toMatchObject({
      code: "tx/missing-entity",
    });
    await expect(check(ping(999_999), bob())).rejects.toMatchObject({
      code: "tx/missing-entity",
    });
    // A 4-element `:db/update` is still a write and is judged (card-one
    // replacement may deny on the implicit retract).
    expect((await check([[":db/update", ids.d1, ":doc/title", "D1b"]], alice())).ok).toBe(true);
    expect((await check([[":db/update", ids.d1, ":doc/title", "nope"]], bob())).ok).toBe(false);
  });

  test("a unique-identity upsert onto an existing entity is `add`, not `create`", async () => {
    // :doc rules give alice `add` on docs she owns; there is no `create` rule
    // reachable without a project, so a create would be denied.
    const p = parsePolicy({
      ...POLICY_JSON,
      ns: {
        ...POLICY_JSON.ns,
        user: {
          ...POLICY_JSON.ns.user,
          add: [A.allow(A.eq(":user/sub", A.claim("sub")))],
          retract: [A.allow(A.eq(":user/sub", A.claim("sub")))],
        },
      },
    });
    const upsert = await checkTx([{ ":user/sub": "u_alice", ":user/name": "Alicia" }], db, p, alice());
    expect(upsert.ok).toBe(true);
    // the same shape for a *new* sub is a create → no create rule → denied
    const create = await checkTx([{ ":user/sub": "u_new", ":user/name": "New" }], db, p, alice());
    expect(create).toMatchObject({ ok: false, code: "policy", op: "create" });
  });

  test("create is allowed through a ref asserted in the same tx, and preset is injected", async () => {
    const r = await check([{ ":db/id": "nd", ":doc/title": "New", ":doc/project": ids.p1 }], alice());
    expect(r.ok).toBe(true);
    const injected = (r as { ops: unknown[] }).ops.slice(-1)[0];
    expect(injected).toEqual([":db/add", "nd", ":doc/owner", ids.alice]);
    // and the whole thing actually transacts
    const rep = await conn.transact((r as { ops: unknown[] }).ops);
    expect((await conn.db().entity(rep.tempids.nd))![":doc/owner"]).toBe(ids.alice);
    // bob is not in p1's org → denied
    expect(await check([{ ":doc/title": "Nope", ":doc/project": ids.p1 }], bob())).toMatchObject({
      ok: false,
      code: "policy",
      attr: ":doc/title",
      op: "create",
    });
  });

  test("a client-supplied preset value on create is denied", async () => {
    const r = await check([{ ":doc/title": "X", ":doc/project": ids.p1, ":doc/owner": ids.bob }], alice());
    expect(r).toEqual({ ok: false, code: "policy", attr: ":doc/owner", op: "create" });
    // re-checking already-injected ops is idempotent (ingress then transactor)
    const first = await check([{ ":db/id": "nd", ":doc/title": "X", ":doc/project": ids.p1 }], alice());
    expect(first.ok).toBe(true);
    expect((await check((first as { ops: unknown[] }).ops, alice())).ok).toBe(true);
    // on an existing entity a preset attribute is a plain `add`: no exemption,
    // no magic — it passes only because this policy's doc `add` rule allows it
    expect((await check([[":db/add", ids.d1, ":doc/owner", ids.bob]], alice())).ok).toBe(true);
    const p = parsePolicy({ ...POLICY_JSON, attrs: { ...POLICY_JSON.attrs, ":doc/owner": { add: [] } } });
    expect(await checkTx([[":db/add", ids.d1, ":doc/owner", ids.bob]], db, p, alice())).toEqual({
      ok: false,
      code: "policy",
      attr: ":doc/owner",
      op: "add",
    });
  });

  test("preset that cannot resolve denies the create", async () => {
    const r = await check([{ ":doc/title": "X", ":doc/project": ids.p1 }], { ...anon(), class: "member" });
    expect(r).toMatchObject({ ok: false, attr: ":doc/title", op: "create" }); // no eid → inOrg fails first
    expect(presetOps(policy, anon(), [{ ref: "x", attrs: [":doc/title"] }])).toEqual({
      ok: false,
      code: "policy",
      attr: ":doc/owner",
      op: "create",
    });
  });

  test("retractEntity expands and is denied when any closure datom is denied", async () => {
    expect((await check([[":db/retractEntity", ids.d1]], alice())).ok).toBe(true);
    expect(await check([[":db/retractEntity", ids.d2]], alice())).toMatchObject({
      ok: false,
      code: "policy",
      op: "retractEntity",
    });
    // an incoming ref from bob's doc is part of d1's closure and drags it down
    await conn.transact([[":db/add", ids.d2, ":doc/project", ids.d1]]);
    const d = conn.db();
    expect(await checkTx([[":db/retractEntity", ids.d1]], d, policy, alice())).toEqual({
      ok: false,
      code: "policy",
      attr: ":doc/project",
      op: "retractEntity",
    });
  });

  test("card-one replacement emits an implicit retract checked against pre-state", async () => {
    // alice owns d1 → add + retract both allowed
    expect((await check([[":db/add", ids.d1, ":doc/title", "D1b"]], alice())).ok).toBe(true);
    // deny `retract` only: the implicit retract is what fails
    const p = parsePolicy({
      ...POLICY_JSON,
      ns: { ...POLICY_JSON.ns, doc: { ...POLICY_JSON.ns.doc, retract: [] } },
    });
    expect(await checkTx([[":db/add", ids.d1, ":doc/title", "D1b"]], db, p, alice())).toEqual({
      ok: false,
      code: "policy",
      attr: ":doc/title",
      op: "retract",
    });
    // no pre-existing value → no implicit retract → still allowed under `p`
    const rep = await conn.transact([{ ":db/id": "d5", ":doc/title": "D5", ":doc/owner": ids.alice }]);
    const d = conn.db();
    expect((await checkTx([[":db/add", rep.tempids.d5, ":doc/audit", "x"]], d, p, alice())).ok).toBe(true);
  });

  test("attributes outside the schema and schema ops are denied for non-admins", async () => {
    expect(await check([[":db/add", ids.d1, ":ghost/attr", 1]], alice())).toEqual({
      ok: false,
      code: "policy",
      attr: ":ghost/attr",
      op: "add",
    });
    expect(await check([{ ":db/ident": ":new/attr", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/optional": true }], alice())).toMatchObject({
      ok: false,
      code: "policy",
      attr: ":db/ident",
    });
  });

  test("admin skips the check and gets its ops back untouched", async () => {
    const ops = [{ ":doc/title": "anything" }, [":db/retractEntity", ids.d2]];
    const r = await check(ops, admin());
    expect(r).toEqual({ ok: true, ops });
  });

  test("a denial never carries values or entity ids", async () => {
    const r = await check([[":db/add", ids.d2, ":doc/title", "leak"]], alice());
    expect(Object.keys(r).sort()).toEqual(["attr", "code", "ok", "op"]);
    expect(JSON.stringify(r)).not.toContain(String(ids.d2));
    expect(JSON.stringify(r)).not.toContain("leak");
  });
});

// ---------------------------------------------------------------------------
// v2 fragment rules — evaluate through the query engine (#154)
// ---------------------------------------------------------------------------

/** Same grants as POLICY_JSON, compiled as named fragment rules. */
const FRAGMENT_POLICY_JSON = {
  version: 2,
  principal: ":user/sub",
  classes: ["anonymous", "member", "admin"],
  superuser: "admin",
  attrs: { ":doc/audit": { read: [{ _tag: "allow", class: ["admin"], rule: true }] } },
  ns: {
    doc: {
      read: [
        { _tag: "allow", rule: "policy/doc/owner" },
        { _tag: "allow", rule: "policy/doc/inOrg" },
      ],
      create: [{ _tag: "allow", rule: "policy/doc/inOrg" }],
      add: [{ _tag: "allow", rule: "policy/doc/owner" }],
      retract: [{ _tag: "allow", rule: "policy/doc/owner" }],
      retractEntity: [{ _tag: "allow", rule: "policy/doc/owner" }],
    },
    project: { read: [{ _tag: "allow", rule: "policy/project/inOrg" }] },
    org: { read: [{ _tag: "allow", rule: "policy/org/members" }] },
    user: { read: [{ _tag: "allow", rule: "policy/user/self" }] },
  },
  preset: { ":doc/owner": { _tag: "principal" } },
  rules: [
    [["policy/doc/owner", "?me", "?e"], ["?e", ":doc/owner", "?me"]],
    [
      ["policy/doc/inOrg", "?me", "?e"],
      ["?e", ":doc/project", "?p"],
      ["?p", ":project/org", "?o"],
      ["?o", ":org/members", "?me"],
    ],
    [
      ["policy/project/inOrg", "?me", "?e"],
      ["?e", ":project/org", "?o"],
      ["?o", ":org/members", "?me"],
    ],
    [["policy/org/members", "?me", "?e"], ["?e", ":org/members", "?me"]],
    [["policy/user/self", "?me", "?e"], [["=", "?e", "?me"]]],
  ],
};

describe("fragment-rule evaluation", () => {
  let frag: CompiledPolicy;
  const view = (p: Principal, base: Db = db, policy = frag) => filterDb(base, db, policy, p);

  beforeEach(() => {
    frag = parsePolicy(FRAGMENT_POLICY_JSON);
  });

  test("a rule follows an attribute the caller cannot read", async () => {
    // :doc/owner is denied at the attribute; the namespace rule still walks it.
    const p = parsePolicy({
      ...FRAGMENT_POLICY_JSON,
      attrs: {
        ":doc/owner": { read: [] },
        ":doc/audit": { read: [{ _tag: "allow", class: ["admin"], rule: true }] },
      },
    });
    const v = filterDb(db, db, p, alice());
    expect(await identsOf(v, ids.d1)).toEqual([":doc/project", ":doc/title"]);
    expect(await v.first(Index.EAVT, { e: ids.d1, a: db.attr(":doc/owner")!.id })).toBeUndefined();
    // if the rule had run over the filtered view, alice could not see her own title
    expect(await identsOf(v, ids.d2)).toEqual([]);
  });

  test("deny by default: a schema attribute the policy never mentions", async () => {
    expect(await identsOf(view(alice()), ids.s1)).toEqual([]);
    expect(await identsOf(view(admin()), ids.s1)).toEqual([":secret/code"]);
  });

  test("scrub and attr narrowing: audit stays hidden unless the class gate holds", async () => {
    expect(await identsOf(view(alice()), ids.d1)).toEqual([":doc/owner", ":doc/project", ":doc/title"]);
    const rows = await query(view(alice()), `[:find (pull ?e [:doc/title :doc/audit]) :where [?e :doc/title]]`);
    expect(rows.map((r: unknown[]) => (r[0] as Record<string, unknown>)[":doc/title"])).toEqual(["D1"]);
    expect((rows[0] as unknown[])[0]).toEqual({ ":doc/title": "D1" });
    expect((await pull(view(alice()), ids.d1, [":doc/title", ":doc/audit"]))![":doc/audit"]).toBeUndefined();
    expect((await pull(view(admin()), ids.d1, [":doc/audit"]))![":doc/audit"]).toBe("who");
    // attr narrowing still ANDs with the namespace rule
    const memberAudit = parsePolicy({
      ...FRAGMENT_POLICY_JSON,
      attrs: { ":doc/audit": { read: [{ _tag: "allow", class: ["member"], rule: true }] } },
    });
    expect(await identsOf(filterDb(db, db, memberAudit, alice()), ids.d1)).toContain(":doc/audit");
    expect(await identsOf(filterDb(db, db, memberAudit, bob()), ids.d1)).toEqual([]);
  });

  test("asOf and history stay judged by the current rule basis", async () => {
    const before = conn.t;
    await conn.transact([[":db/retract", ids.org1, ":org/members", ids.alice]]);
    const cur = conn.db();
    const v = filterDb(cur, cur, frag, alice());
    expect(await identsOf(v, ids.p1)).toEqual([]);
    expect(await identsOf(v.asOf(before), ids.p1)).toEqual([]);
    expect(await identsOf(v.history(), ids.p1)).toEqual([]);
    expect(await identsOf(v.asOf(before), ids.d1)).toContain(":doc/title");
    expect((await v.history().datomsArray(Index.EAVT, { e: ids.d1, a: db.attr(":doc/audit")!.id }))).toEqual([]);
  });

  test("unresolved principal fails closed; only true arms apply", async () => {
    const noEid = user("u_alice", undefined);
    expect(await identsOf(view(noEid), ids.d1)).toEqual([]);
    const publicRead = parsePolicy({
      version: 2,
      principal: ":user/sub",
      classes: ["anonymous", "member", "admin"],
      attrs: {},
      ns: { doc: { read: [{ _tag: "allow", rule: true }] } },
      preset: {},
    });
    expect(await identsOf(filterDb(db, db, publicRead, noEid), ids.d1)).toContain(":doc/title");
    expect(await identsOf(filterDb(db, db, publicRead, anon()), ids.d1)).toContain(":doc/title");
  });

  test("create follows a ref asserted in the same tx (overlay)", async () => {
    const r = await checkTx(
      [{ ":db/id": "nd", ":doc/title": "New", ":doc/project": ids.p1 }],
      db,
      frag,
      alice(),
    );
    expect(r.ok).toBe(true);
    expect((r as { ops: unknown[] }).ops.slice(-1)[0]).toEqual([":db/add", "nd", ":doc/owner", ids.alice]);
    expect(
      await checkTx([{ ":doc/title": "Nope", ":doc/project": ids.p1 }], db, frag, bob()),
    ).toMatchObject({ ok: false, code: "policy", attr: ":doc/title", op: "create" });
  });

  test("add/retract/retractEntity evaluate against db-before, not the overlay", async () => {
    expect((await checkTx([[":db/add", ids.d1, ":doc/title", "D1b"]], db, frag, alice())).ok).toBe(true);
    // d2 has no :doc/audit yet, so this is a pure `add` (no implicit retract)
    expect(await checkTx([[":db/add", ids.d2, ":doc/audit", "x"]], db, frag, alice())).toMatchObject({
      ok: false,
      code: "policy",
      op: "add",
    });
    expect((await checkTx([[":db/retractEntity", ids.d1]], db, frag, alice())).ok).toBe(true);
    expect(await checkTx([[":db/retractEntity", ids.d2]], db, frag, alice())).toMatchObject({
      ok: false,
      code: "policy",
      op: "retractEntity",
    });
  });

  test("a rule that blows the query budget is a typed error, not a deny", async () => {
    const blow = parsePolicy({
      version: 2,
      principal: ":user/sub",
      classes: ["member"],
      attrs: {},
      ns: { doc: { read: [{ _tag: "allow", rule: "policy/blow" }] } },
      preset: {},
      rules: [
        [["policy/counts", "?x"], [["ground", 0], "?x"]],
        [["policy/counts", "?x"], ["policy/counts", "?y"], [["+", "?y", 1], "?x"]],
        [["policy/blow", "?me", "?e"], ["policy/counts", "?n"], ["?e", ":doc/title", "_"]],
      ],
    });
    let err: unknown;
    try {
      await allowsOp(blow, "read", ":doc/title", {
        db,
        principal: alice(),
        e: ids.d1,
        memo: new PolicyMemo(10_000),
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PolicyBudgetError);
    expect(err).toMatchObject({ code: "policy/budget-exceeded", rule: "policy/blow" });
    const v = filterDb(db, db, blow, alice(), { maxCells: 10_000 });
    await expect(identsOf(v, ids.d1)).rejects.toBeInstanceOf(PolicyBudgetError);
  });

  test("compiled head vars bind positionally to principal and focus", async () => {
    const p = parsePolicy({
      ...FRAGMENT_POLICY_JSON,
      ns: { doc: { read: [{ _tag: "allow", rule: "policy/doc/owner" }] } },
      rules: [[["policy/doc/owner", "?q1", "?q2"], ["?q2", ":doc/owner", "?q1"]]],
    });
    expect(await identsOf(filterDb(db, db, p, alice()), ids.d1)).toContain(":doc/title");
    expect(await identsOf(filterDb(db, db, p, bob()), ids.d1)).toEqual([]);
  });

  test("PolicyMemo caches a (rule, e) hit", async () => {
    const memo = new PolicyMemo();
    const ctx = { db, principal: alice(), e: ids.d1, memo };
    expect(await allowsOp(frag, "read", ":doc/title", ctx)).toBe(true);
    expect(memo.getRule("policy/doc/owner|" + ids.d1)).toBe(true);
    const owned = memo.visibleSet("policy/doc/owner");
    expect(owned?._tag).toBe("set");
    if (owned?._tag === "set") expect(owned.eids.has(ids.d1)).toBe(true);
    expect(await allowsOp(frag, "read", ":doc/title", ctx)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Visible-set materialization (#156)
// ---------------------------------------------------------------------------

const TITLES = { find: ["?e", "?t"], where: [["?e", ":doc/title", "?t"]] };

function mulberry32(seed: number): () => number {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("visible-set materialization", () => {
  test("set path ≡ per-entity path on a selective scan", async () => {
    const p = parsePolicy({
      ...FRAGMENT_POLICY_JSON,
      ns: { doc: { read: [{ _tag: "allow", rule: "policy/doc/owner" }] } },
      rules: [[["policy/doc/owner", "?me", "?e"], ["?e", ":doc/owner", "?me"]]],
    });
    const setView = filterDb(db, db, p, alice());
    const boundView = filterDb(db, db, p, alice(), { visibleSetMax: 0 });
    expect(await query(setView, TITLES, [], { pushdown: false })).toEqual(
      await query(boundView, TITLES, [], { pushdown: false }),
    );
    const memo = policyView(setView)!.memo;
    expect(memo.visibleSetFallbackCount).toBe(0);
    const vis = memo.visibleSet("policy/doc/owner");
    expect(vis?._tag).toBe("set");
    if (vis?._tag === "set") {
      expect(vis.eids.has(ids.d1)).toBe(true);
      expect(vis.eids.has(ids.d2)).toBe(false);
    }
    expect(policyView(boundView)!.memo.visibleSet("policy/doc/owner")).toBeUndefined();
  });

  test("set path ≡ per-entity path on randomized policies and data", async () => {
    const kinds = ["owner", "org", "or"] as const;
    for (const seed of [1, 7, 13, 42, 99, 123, 256, 1024]) {
      const rand = mulberry32(seed);
      const kind = kinds[Math.floor(rand() * kinds.length)]!;
      const nUsers = 6;
      const nOrgs = 3;
      const nDocs = 24;
      const c = await Connection.create({ now: () => 1_700_000_000_000 });
      await c.transact(SCHEMA);
      const users = Array.from({ length: nUsers }, (_, i) => ({
        ":db/id": `u${i}`,
        ":user/sub": `u_${i}`,
        ":user/name": `U${i}`,
      }));
      const orgs = Array.from({ length: nOrgs }, (_, i) => ({
        ":db/id": `o${i}`,
        ":org/name": `O${i}`,
        ":org/members": Array.from({ length: nUsers }, (_, u) => `u${u}`).filter(() => rand() < 0.45),
      }));
      // every org keeps at least user 0 so the caller is sometimes in, sometimes not
      if ((orgs[0][":org/members"] as string[]).length === 0) (orgs[0][":org/members"] as string[]).push("u0");
      const projects = orgs.map((_, i) => ({ ":db/id": `p${i}`, ":project/name": `P${i}`, ":project/org": `o${i}` }));
      const docs = Array.from({ length: nDocs }, (_, i) => ({
        ":db/id": `d${i}`,
        ":doc/title": `T${i}`,
        ":doc/owner": `u${Math.floor(rand() * nUsers)}`,
        ":doc/project": `p${Math.floor(rand() * nOrgs)}`,
        ...(rand() < 0.3 ? { ":doc/audit": "a" } : {}),
      }));
      const { tempids } = await c.transact([...users, ...orgs, ...projects, ...docs]);
      const d = c.db();
      const me: Principal = {
        kind: "user",
        class: "member",
        sub: "u_0",
        eid: tempids.u0,
        claims: { sub: "u_0" },
        db: "acme",
      };
      const read =
        kind === "owner"
          ? [{ _tag: "allow" as const, rule: "policy/doc/owner" }]
          : kind === "org"
            ? [{ _tag: "allow" as const, rule: "policy/doc/inOrg" }]
            : [
                { _tag: "allow" as const, rule: "policy/doc/owner" },
                { _tag: "allow" as const, rule: "policy/doc/inOrg" },
              ];
      const p = parsePolicy({
        ...FRAGMENT_POLICY_JSON,
        ns: { ...FRAGMENT_POLICY_JSON.ns, doc: { ...FRAGMENT_POLICY_JSON.ns.doc, read } },
      });
      const setRows = await query(filterDb(d, d, p, me), TITLES, [], { pushdown: false });
      const boundRows = await query(filterDb(d, d, p, me, { visibleSetMax: 0 }), TITLES, [], { pushdown: false });
      expect(setRows, `seed=${seed} kind=${kind}`).toEqual(boundRows);
      const audit = { find: ["?e", "?a"], where: [["?e", ":doc/audit", "?a"]] };
      expect(await query(filterDb(d, d, p, me), audit, [], { pushdown: false }), `seed=${seed} audit`).toEqual(
        await query(filterDb(d, d, p, me, { visibleSetMax: 0 }), audit, [], { pushdown: false }),
      );
    }
  });

  test("an over-threshold set falls back to per-entity and is recorded", async () => {
    const events: TelemetryEvent[] = [];
    setTelemetrySink((e) => events.push(e));
    try {
      await conn.transact([
        { ":doc/title": "D3", ":doc/owner": ids.alice, ":doc/project": ids.p1 },
        { ":doc/title": "D4", ":doc/owner": ids.alice, ":doc/project": ids.p1 },
        { ":doc/title": "D5", ":doc/owner": ids.alice, ":doc/project": ids.p1 },
      ]);
      const d = conn.db();
      const p = parsePolicy({
        ...FRAGMENT_POLICY_JSON,
        ns: { doc: { read: [{ _tag: "allow", rule: "policy/doc/owner" }] } },
        rules: [[["policy/doc/owner", "?me", "?e"], ["?e", ":doc/owner", "?me"]]],
      });
      const setView = filterDb(d, d, p, alice(), { visibleSetMax: 2 });
      const boundView = filterDb(d, d, p, alice(), { visibleSetMax: 0 });
      expect(await query(setView, TITLES, [], { pushdown: false })).toEqual(
        await query(boundView, TITLES, [], { pushdown: false }),
      );
      const memo = policyView(setView)!.memo;
      expect(memo.visibleSetFallbackCount).toBe(1);
      expect(memo.visibleSetFallbacks).toEqual([{ rule: "policy/doc/owner", reason: "size", size: 3 }]);
      expect(memo.visibleSet("policy/doc/owner")).toEqual({ _tag: "fallback" });
      const ev = events.find((e) => e.event === "policy.visible-set-fallback");
      expect(ev).toMatchObject({
        component: "core",
        level: "info",
        rule: "policy/doc/owner",
        reason: "size",
        size: 3,
        threshold: 2,
        count: 1,
      });
    } finally {
      setTelemetrySink(undefined);
    }
  });

  test("true arms and admin never materialize a set", async () => {
    const publicRead = parsePolicy({
      version: 2,
      principal: ":user/sub",
      classes: ["anonymous", "member", "admin"],
      attrs: {},
      ns: { doc: { read: [{ _tag: "allow", rule: true }] } },
      preset: {},
    });
    const v = filterDb(db, db, publicRead, alice());
    expect(await query(v, TITLES)).toHaveLength(2);
    expect(policyView(v)!.memo.visibleSetFallbackCount).toBe(0);
    expect([...policyView(v)!.memo.visibleSetFallbacks]).toEqual([]);
    expect(policyView(v)!.memo.visibleSet("policy/doc/owner")).toBeUndefined();
    const frag = parsePolicy(FRAGMENT_POLICY_JSON);
    expect(filterDb(db, db, frag, admin())).toBe(db);
    expect(policyView(filterDb(db, db, frag, admin()))).toBeUndefined();
  });

  test("write arms stay on the per-entity path", async () => {
    const frag = parsePolicy(FRAGMENT_POLICY_JSON);
    const memo = new PolicyMemo();
    expect(
      await allowsOp(frag, "add", ":doc/title", { db, principal: alice(), e: ids.d1, memo }),
    ).toBe(true);
    expect(memo.visibleSet("policy/doc/owner")).toBeUndefined();
    expect(memo.getRule("policy/doc/owner|" + ids.d1)).toBe(true);
  });

  test("a set-query budget miss falls back; the bound path may still allow", async () => {
    const extra = Array.from({ length: 16 }, (_, i) => ({
      ":doc/title": `W${i}`,
      ":doc/owner": ids.alice,
      ":doc/project": ids.p1,
    }));
    await conn.transact(extra);
    const d = conn.db();
    const p = parsePolicy({
      version: 2,
      principal: ":user/sub",
      classes: ["member"],
      attrs: {},
      ns: { doc: { read: [{ _tag: "allow", rule: "policy/wide" }] } },
      preset: {},
      rules: [
        [
          ["policy/wide", "?me", "?e"],
          ["?e", ":doc/title", "_"],
          ["?x", ":doc/title", "_"],
          ["?y", ":doc/title", "_"],
          ["?e", ":doc/owner", "?me"],
        ],
      ],
    });
    const v = filterDb(d, d, p, alice(), { maxCells: 2_000 });
    const rows = await query(v, TITLES, [], { pushdown: false });
    expect(rows.length).toBeGreaterThan(0);
    const memo = policyView(v)!.memo;
    expect(memo.visibleSetFallbacks.some((f) => f.rule === "policy/wide" && f.reason === "budget")).toBe(true);
  });
});
