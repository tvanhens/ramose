import { beforeEach, describe, expect, test } from "bun:test";
import { Connection } from "../../../src/internal/core/conn.ts";
import { Index, ValueTag } from "../../../src/internal/core/datom.ts";
import type { Db } from "../../../src/internal/core/db.ts";
import {
  type CompiledPolicy,
  type Principal,
  PolicyAst as A,
  PolicyParseError,
  checkTx,
  filterDb,
  isAdmin,
  parsePolicy,
  policyView,
  presetOps,
} from "../../../src/internal/core/policy/index.ts";
import { query } from "../../../src/internal/core/query/engine.ts";
import { pull } from "../../../src/internal/core/query/pull.ts";

const SCHEMA = [
  { ":db/ident": ":user/sub", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/unique": ":db.unique/identity" },
  { ":db/ident": ":user/name", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one" },
  { ":db/ident": ":org/name", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one" },
  { ":db/ident": ":org/members", ":db/valueType": ":db.type/ref", ":db/cardinality": ":db.cardinality/many" },
  { ":db/ident": ":project/org", ":db/valueType": ":db.type/ref", ":db/cardinality": ":db.cardinality/one" },
  { ":db/ident": ":project/name", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/index": true },
  { ":db/ident": ":doc/title", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/index": true },
  { ":db/ident": ":doc/owner", ":db/valueType": ":db.type/ref", ":db/cardinality": ":db.cardinality/one" },
  { ":db/ident": ":doc/project", ":db/valueType": ":db.type/ref", ":db/cardinality": ":db.cardinality/one" },
  { ":db/ident": ":doc/audit", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one" },
  { ":db/ident": ":secret/code", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one" },
];

/** doc → project → org → members ∋ principal */
const inOrg = A.ref(":doc/project", A.ref(":project/org", A.eq(":org/members", A.principal)));

const POLICY_JSON = {
  version: 1,
  principal: ":user/sub",
  classes: ["anonymous", "member", "admin"],
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
  });

  test("accepts a version-2 fragment policy", () => {
    const p = parsePolicy({
      version: 2,
      principal: ":user/sub",
      classes: ["member", "admin"],
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

  test("admin bypasses the filter entirely", async () => {
    expect(filterDb(db, db, policy, admin())).toBe(db);
    expect(isAdmin(admin())).toBe(true);
    expect(isAdmin(alice())).toBe(false);
    expect(isAdmin({ ...alice(), kind: "service" })).toBe(false); // a service token is not data-plane admin
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

describe("checkTx", () => {
  const check = (ops: unknown[], p: Principal, d: Db = db) => checkTx(ops, d, policy, p);

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
    expect(await check([{ ":db/ident": ":new/attr", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one" }], alice())).toMatchObject({
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
