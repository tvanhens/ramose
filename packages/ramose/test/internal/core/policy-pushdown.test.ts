/**
 * Clause-level policy pushdown (#157). Equivalence with the filtered-only
 * path is the merge gate: pushdown result ≡ `{ pushdown: false }` on
 * randomized policies, data, and queries — including or/not, recursion,
 * and mixed find (pull + aggregate). Conjunction is in `:where` only.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { Connection } from "../../../src/internal/core/conn.ts";
import { Index } from "../../../src/internal/core/datom.ts";
import type { Db } from "../../../src/internal/core/db.ts";
import {
  type CompiledPolicy,
  type Principal,
  QueryBudgetError,
  conjoinPolicy,
  filterDb,
  parsePolicy,
  parseQuery,
  policyView,
  query,
  type QueryStats,
} from "../../../src/internal/core/index.ts";

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
];

const FRAGMENT_POLICY_JSON = {
  version: 2 as const,
  principal: ":user/sub",
  classes: ["anonymous", "member", "admin"],
  attrs: { ":doc/audit": { read: [{ _tag: "allow" as const, class: ["admin"], rule: true as const }] } },
  ns: {
    doc: {
      read: [
        { _tag: "allow" as const, rule: "policy/doc/owner" },
        { _tag: "allow" as const, rule: "policy/doc/inOrg" },
      ],
    },
    project: { read: [{ _tag: "allow" as const, rule: "policy/project/inOrg" }] },
    org: { read: [{ _tag: "allow" as const, rule: "policy/org/members" }] },
    user: { read: [{ _tag: "allow" as const, rule: "policy/user/self" }] },
  },
  preset: { ":doc/owner": { _tag: "principal" as const } },
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

let conn: Connection;
let db: Db;
let ids: Record<string, number>;
let policy: CompiledPolicy;

const user = (sub: string, eid: number | undefined, cls = "member"): Principal => ({
  kind: "user",
  class: cls,
  sub,
  eid,
  claims: { sub },
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
  ]);
  ids = rep.tempids;
  db = conn.db();
  policy = parsePolicy(FRAGMENT_POLICY_JSON);
});

const alice = () => user("u_alice", ids.alice);
const bob = () => user("u_bob", ids.bob);
const viewFor = (p: Principal, base: Db = db, pol = policy) => filterDb(base, db, pol, p);

const both = async (v: Db, q: object | string) => {
  const push = await query(v, q);
  const filtered = await query(v, q, [], { pushdown: false });
  return { push, filtered };
};

function mulberry32(seed: number): () => number {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sortRows(rows: unknown): unknown {
  if (!Array.isArray(rows)) return rows;
  if (rows.length === 0) return rows;
  if (typeof rows[0] === "object" && rows[0] !== null && !Array.isArray(rows[0])) {
    return [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return [...rows].map((r) => (Array.isArray(r) ? r : [r])).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

// ---------------------------------------------------------------------------

describe("clause provenance and planner rewrite", () => {
  test("conjoinPolicy stamps origin: rule onto injected clauses", () => {
    const v = viewFor(alice());
    const view = policyView(v)!;
    const ast = parseQuery({ find: ["?t"], where: [["?e", ":doc/title", "?t"]] });
    const pd = conjoinPolicy(ast, view);
    expect(pd.query.where.length).toBeGreaterThan(ast.where.length);
    const added = pd.query.where.slice(ast.where.length);
    expect(added.every((c) => c.origin === "rule")).toBe(true);
    expect(pd.covered).toContain("doc");
    expect(pd.meVar).toBe("?__ramose_me");
    expect(pd.meValue).toBe(ids.alice);
  });

  test("executor stats tag expanded rule clauses as origin: rule", async () => {
    const stats: QueryStats = { clauses: [] };
    await query(viewFor(alice()), { find: ["?t"], where: [["?e", ":doc/title", "?t"]] }, [], { stats });
    const ruleOrigin = stats.clauses.filter((c) => c.origin === "rule");
    expect(ruleOrigin.length).toBeGreaterThan(0);
    expect(ruleOrigin.some((c) => c.clause.includes(":doc/owner") || c.clause.includes(":doc/project"))).toBe(true);
    const caller = stats.clauses.filter((c) => c.origin === "caller");
    expect(caller.some((c) => c.clause.includes(":doc/title"))).toBe(true);
  });

  test("true arms and admin skip conjunction", () => {
    const pub = parsePolicy({
      version: 2,
      principal: ":user/sub",
      classes: ["member", "admin"],
      attrs: {},
      ns: { doc: { read: [{ _tag: "allow", rule: true }] } },
      preset: {},
    });
    const v = filterDb(db, db, pub, alice());
    const ast = parseQuery({ find: ["?t"], where: [["?e", ":doc/title", "?t"]] });
    const pd = conjoinPolicy(ast, policyView(v)!);
    expect(pd.query.where).toEqual(ast.where);
    expect(pd.covered).toEqual([]);
    expect(filterDb(db, db, policy, user("u_alice", ids.alice, "admin"))).toBe(db);
  });

  test("an already-present rule-call is entailed and not re-injected", () => {
    const v = viewFor(alice());
    const ast = parseQuery({
      find: ["?t"],
      where: [
        ["?e", ":doc/title", "?t"],
        ["policy/doc/owner", "?me", "?e"],
        ["policy/doc/inOrg", "?me", "?e"],
      ],
      rules: FRAGMENT_POLICY_JSON.rules,
    });
    const pd = conjoinPolicy(ast, policyView(v)!);
    expect(pd.query.where.length).toBe(ast.where.length);
  });

  test("per-var: a join across namespaces conjoins each namespace's rule", () => {
    const v = viewFor(alice());
    const ast = parseQuery({
      find: ["?t", "?n"],
      where: [
        ["?e", ":doc/title", "?t"],
        ["?e", ":doc/project", "?p"],
        ["?p", ":project/name", "?n"],
      ],
    });
    const pd = conjoinPolicy(ast, policyView(v)!);
    const added = pd.query.where.slice(ast.where.length);
    expect(pd.covered).toEqual(expect.arrayContaining(["doc", "project"]));
    expect(added.length).toBeGreaterThanOrEqual(2);
  });
});

describe("two-view join", () => {
  test("a rule follows an attribute the caller cannot read", async () => {
    const p = parsePolicy({
      ...FRAGMENT_POLICY_JSON,
      attrs: {
        ":doc/owner": { read: [] },
        ":doc/audit": { read: [{ _tag: "allow", class: ["admin"], rule: true }] },
      },
    });
    const v = filterDb(db, db, p, alice());
    expect(await v.first(Index.EAVT, { e: ids.d1, a: db.attr(":doc/owner")!.id })).toBeUndefined();
    const { push, filtered } = await both(v, { find: ["?t"], where: [["?e", ":doc/title", "?t"]] });
    expect(sortRows(push)).toEqual(sortRows(filtered));
    expect(push.flat()).toEqual(["D1"]);
  });

  test("attr-level narrowing still hides audit under pushdown", async () => {
    const v = viewFor(alice());
    const { push, filtered } = await both(v, { find: ["?a"], where: [["?e", ":doc/audit", "?a"]] });
    expect(push).toEqual([]);
    expect(filtered).toEqual([]);
    const pulled = await both(v, `[:find (pull ?e [:doc/title :doc/audit]) :where [?e :doc/title]]`);
    expect(sortRows(pulled.push)).toEqual(sortRows(pulled.filtered));
    expect((pulled.push[0] as unknown[])[0]).toEqual({ ":doc/title": "D1" });
  });

  test("asOf / history stay judged by the current rule basis", async () => {
    const before = conn.t;
    await conn.transact([[":db/retract", ids.org1, ":org/members", ids.alice]]);
    const cur = conn.db();
    const v = filterDb(cur, cur, policy, alice());
    const q = { find: ["?n"], where: [["?e", ":project/name", "?n"]] };
    const { push, filtered } = await both(v.asOf(before), q);
    expect(push).toEqual([]);
    expect(filtered).toEqual([]);
    const hist = await both(v.history(), q);
    expect(hist.push).toEqual([]);
    expect(hist.filtered).toEqual([]);
    const titles = await both(v, { find: ["?t"], where: [["?e", ":doc/title", "?t"]] });
    expect(sortRows(titles.push)).toEqual(sortRows(titles.filtered));
    expect(titles.push.flat()).toEqual(["D1"]);
  });
});

describe("pre-aggregation conjunction", () => {
  test("count ≡ filtered-only — a count never includes hidden rows", async () => {
    const v = viewFor(alice());
    const q = { find: [["count", "?e"]], where: [["?e", ":doc/title", "?t"]] };
    const { push, filtered } = await both(v, q);
    expect(push).toEqual([[1]]);
    expect(filtered).toEqual([[1]]);
    const bobV = viewFor(bob());
    expect(await query(bobV, q)).toEqual([[1]]);
    expect(await query(bobV, q, [], { pushdown: false })).toEqual([[1]]);
  });

  test("having is not rewritten — conjunction lives in where", () => {
    const ast = parseQuery({
      find: [["count", "?e"]],
      where: [["?e", ":doc/title", "?t"]],
      having: [[[">", "?e", 0]]],
    });
    const pd = conjoinPolicy(ast, policyView(viewFor(alice()))!);
    expect(pd.query.having).toEqual(ast.having);
    expect(pd.query.where[0]).toEqual(ast.where[0]);
    expect(pd.query.where.slice(1).every((c) => c.origin === "rule")).toBe(true);
  });
});

describe("budget attribution", () => {
  test("a policy rule that blows the budget reports spentBy: policy", async () => {
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
    const v = filterDb(db, db, blow, alice(), { maxCells: 2_000 });
    const view = policyView(v)!;
    const ast = parseQuery({ find: ["?t"], where: [["?e", ":doc/title", "?t"]] });
    const pd = conjoinPolicy(ast, view);
    expect(pd.covered).toContain("doc");
    expect(pd.query.where.some((c) => c.origin === "rule")).toBe(true);
    let err: unknown;
    try {
      await query(v, ast, [], { maxCells: 2_000 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(QueryBudgetError);
    const be = err as QueryBudgetError;
    expect(be.code).toBe("query/budget-exceeded");
    expect(be.spentBy).toBe("policy");
    expect(be.message).toContain("spent by policy clauses");
  });

  test("a caller-only blow reports spentBy: caller", async () => {
    const pub = parsePolicy({
      version: 2,
      principal: ":user/sub",
      classes: ["member"],
      attrs: {},
      ns: { doc: { read: [{ _tag: "allow", rule: true }] } },
      preset: {},
    });
    const v = filterDb(db, db, pub, alice());
    let err: unknown;
    try {
      await query(
        v,
        {
          find: ["?e", "?x"],
          where: [
            ["?e", ":doc/title", "?t"],
            [["ground", Array.from({ length: 80 }, (_, i) => i)], ["?x", "..."]],
          ],
        },
        [],
        { maxCells: 40 },
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(QueryBudgetError);
    expect((err as QueryBudgetError).spentBy).toBe("caller");
    expect(String((err as Error).message)).not.toContain("spent by policy");
  });
});

describe("equivalence: pushdown ≡ filtered-only", () => {
  const queries: { name: string; q: object | string }[] = [
    { name: "titles", q: { find: ["?e", "?t"], where: [["?e", ":doc/title", "?t"]] } },
    { name: "audit", q: { find: ["?e", "?a"], where: [["?e", ":doc/audit", "?a"]] } },
    { name: "or", q: { find: ["?t"], where: [["or", ["?e", ":doc/title", "?t"], ["?e", ":doc/audit", "?t"]]] } },
    {
      name: "not",
      q: {
        find: ["?t"],
        where: [
          ["?e", ":doc/title", "?t"],
          ["not", ["?e", ":doc/audit", "_"]],
        ],
      },
    },
    { name: "count", q: { find: [["count", "?e"]], where: [["?e", ":doc/title", "?t"]] } },
    { name: "pull", q: `[:find (pull ?e [:doc/title :doc/audit]) :where [?e :doc/title]]` },
    {
      name: "named rule",
      q: {
        find: ["?t"],
        where: [["titled", "?e"], ["?e", ":doc/title", "?t"]],
        rules: [[["titled", "?e"], ["?e", ":doc/title", "_"]]],
      },
    },
    {
      name: "recursive",
      q: {
        find: ["?t"],
        where: [["reach", "?e"], ["?e", ":doc/title", "?t"]],
        rules: [
          [["reach", "?e"], ["?e", ":doc/title", "_"]],
          [["reach", "?e"], ["?e", ":doc/project", "?p"], ["reach", "?p"]],
        ],
      },
    },
  ];

  test("fixed dataset, every query shape", async () => {
    for (const { name, q } of queries) {
      const { push, filtered } = await both(viewFor(alice()), q);
      expect(sortRows(push), name).toEqual(sortRows(filtered));
    }
  });

  test("randomized policies, data, and queries", async () => {
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
      const v = filterDb(d, d, p, me);
      const shape = queries[Math.floor(rand() * queries.length)]!;
      const { push, filtered } = await both(v, shape.q);
      expect(sortRows(push), `seed=${seed} kind=${kind} ${shape.name}`).toEqual(sortRows(filtered));
      const titles = await both(v, { find: ["?e", "?t"], where: [["?e", ":doc/title", "?t"]] });
      expect(sortRows(titles.push), `seed=${seed} titles`).toEqual(sortRows(titles.filtered));
      const countQ = { find: [["count", "?e"]], where: [["?e", ":doc/title", "?t"]] };
      expect(await query(v, countQ), `seed=${seed} count`).toEqual(await query(v, countQ, [], { pushdown: false }));
    }
  });

  test("unresolved principal fails closed under both paths", async () => {
    const noEid = user("u_alice", undefined);
    const v = viewFor(noEid);
    const { push, filtered } = await both(v, { find: ["?t"], where: [["?e", ":doc/title", "?t"]] });
    expect(push).toEqual([]);
    expect(filtered).toEqual([]);
  });
});
