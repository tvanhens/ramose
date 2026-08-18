import { beforeAll, describe, expect, test } from "bun:test";
import { Connection } from "../src/conn.ts";
import type { Db } from "../src/db.ts";
import type { PullAttrSpec } from "../src/query/ast.ts";
import { query } from "../src/query/engine.ts";
import { parsePullPattern } from "../src/query/parse.ts";
import { pull } from "../src/query/pull.ts";

const SCHEMA = [
  { ":db/ident": ":user/name", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one" },
  { ":db/ident": ":user/tags", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/many" },
  { ":db/ident": ":user/starred", ":db/valueType": ":db.type/ref", ":db/cardinality": ":db.cardinality/many" },
  { ":db/ident": ":todo/title", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one" },
  { ":db/ident": ":todo/done", ":db/valueType": ":db.type/boolean", ":db/cardinality": ":db.cardinality/one" },
  { ":db/ident": ":todo/rank", ":db/valueType": ":db.type/long", ":db/cardinality": ":db.cardinality/one" },
  { ":db/ident": ":todo/owner", ":db/valueType": ":db.type/ref", ":db/cardinality": ":db.cardinality/one" },
  { ":db/ident": ":todo/project", ":db/valueType": ":db.type/ref", ":db/cardinality": ":db.cardinality/one" },
  { ":db/ident": ":project/name", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one" },
];

let db: Db;
let ids: Record<string, number>;

/** The `:todo/title`s of a pulled nested collection, in the order pulled. */
const titles = (r: Record<string, unknown> | null, key: string): string[] =>
  ((r?.[key] as Record<string, unknown>[] | undefined) ?? []).map((t) => t[":todo/title"] as string);

/** An already-lowered AST spec, as the alchemy client sends it over the wire. */
const spec = (s: Partial<Omit<PullAttrSpec, "sub">> & { attr: string; sub?: unknown[] }): PullAttrSpec =>
  parsePullPattern([{ kind: "attr", reverse: false, ...s }])[0] as PullAttrSpec;

beforeAll(async () => {
  const conn = await Connection.create();
  await conn.transact(SCHEMA);
  const rep = await conn.transact([
    { ":db/id": "ada", ":user/name": "Ada", ":user/tags": ["zeta", "alpha", "mid", "beta"] },
    { ":db/id": "bob", ":user/name": "Bob" },
    { ":db/id": "cy", ":user/name": "Cy" },
    { ":db/id": "work", ":project/name": "Work" },
    { ":db/id": "home", ":project/name": "Home" },
    // Ada: a mix of done/open, ranks deliberately out of index order
    { ":db/id": "t1", ":todo/title": "a-open", ":todo/done": false, ":todo/rank": 5, ":todo/owner": "ada", ":todo/project": "work" },
    { ":db/id": "t2", ":todo/title": "b-done", ":todo/done": true, ":todo/rank": 1, ":todo/owner": "ada", ":todo/project": "home" },
    { ":db/id": "t3", ":todo/title": "c-open", ":todo/done": false, ":todo/rank": 3, ":todo/owner": "ada", ":todo/project": "home" },
    { ":db/id": "t4", ":todo/title": "d-open", ":todo/done": false, ":todo/owner": "ada", ":todo/project": "work" }, // no rank
    { ":db/id": "t5", ":todo/title": "e-open", ":todo/done": false, ":todo/rank": 2, ":todo/owner": "ada", ":todo/project": "work" },
    // Bob: everything done
    { ":db/id": "t6", ":todo/title": "f-done", ":todo/done": true, ":todo/rank": 9, ":todo/owner": "bob", ":todo/project": "work" },
    // Cy: one open todo
    { ":db/id": "t7", ":todo/title": "g-open", ":todo/done": false, ":todo/rank": 4, ":todo/owner": "cy", ":todo/project": "home" },
  ]);
  ids = rep.tempids;
  await conn.transact([{ ":db/id": ids.ada, ":user/starred": [ids.t4, ids.t2, ids.t3, ids.t1] }]);
  db = conn.db();
});

describe("nested pull: where", () => {
  test("backlink collection filtered per element", async () => {
    const r = await pull(db, ids.ada, [
      ":user/name",
      spec({
        attr: ":todo/owner",
        reverse: true,
        sub: [":todo/title"],
        where: [{ path: [":todo/done"], op: "=", value: false }],
      }),
    ]);
    expect(r![":user/name"]).toBe("Ada");
    expect(titles(r, ":todo/_owner").sort()).toEqual(["a-open", "c-open", "d-open", "e-open"]);
  });

  test("forward card-many ref collection filtered per element", async () => {
    const r = await pull(db, ids.ada, [
      spec({
        attr: ":user/starred",
        sub: [":todo/title"],
        where: [{ path: [":todo/done"], op: "=", value: false }],
      }),
    ]);
    expect(titles(r, ":user/starred").sort()).toEqual(["a-open", "c-open", "d-open"]);
  });

  test("scalar card-many filtered by the value itself (empty path)", async () => {
    const r = await pull(db, ids.ada, [spec({ attr: ":user/tags", where: [{ path: [], op: "starts-with?", value: "b" }] })]);
    expect(r![":user/tags"]).toEqual(["beta"]);
    const inList = await pull(db, ids.ada, [spec({ attr: ":user/tags", where: [{ path: [], op: "in", value: ["alpha", "zeta", "nope"] }] })]);
    expect((inList![":user/tags"] as string[]).sort()).toEqual(["alpha", "zeta"]);
  });

  test("multi-hop path, reverse hop and :db/id", async () => {
    // element → :todo/project → :project/name
    const hop = await pull(db, ids.ada, [
      spec({
        attr: ":todo/owner",
        reverse: true,
        sub: [":todo/title"],
        where: [{ path: [":todo/project", ":project/name"], op: "=", value: "Work" }],
      }),
    ]);
    expect(titles(hop, ":todo/_owner").sort()).toEqual(["a-open", "d-open", "e-open"]);

    // element → its project → back through :todo/project → some sibling is done
    const rev = await pull(db, ids.ada, [
      spec({
        attr: ":todo/owner",
        reverse: true,
        sub: [":todo/title"],
        where: [{ path: [":todo/project", ":todo/project", ":todo/done"], reverse: [false, true, false], op: "=", value: true }],
      }),
    ]);
    // Work has a done todo (f-done, Bob's); Home has b-done → every Ada todo qualifies
    expect(titles(rev, ":todo/_owner").length).toBe(5);

    const byId = await pull(db, ids.ada, [
      spec({ attr: ":todo/owner", reverse: true, sub: [":todo/title"], where: [{ path: [":db/id"], op: "=", value: ids.t3 }] }),
    ]);
    expect(titles(byId, ":todo/_owner")).toEqual(["c-open"]);
  });

  test("exists / missing", async () => {
    const has = await pull(db, ids.ada, [
      spec({ attr: ":todo/owner", reverse: true, sub: [":todo/title"], where: [{ path: [":todo/rank"], op: "exists" }] }),
    ]);
    expect(titles(has, ":todo/_owner").sort()).toEqual(["a-open", "b-done", "c-open", "e-open"]);
    const lacks = await pull(db, ids.ada, [
      spec({ attr: ":todo/owner", reverse: true, sub: [":todo/title"], where: [{ path: [":todo/rank"], op: "missing" }] }),
    ]);
    expect(titles(lacks, ":todo/_owner")).toEqual(["d-open"]);
  });

  test("several predicates are ANDed", async () => {
    const r = await pull(db, ids.ada, [
      spec({
        attr: ":todo/owner",
        reverse: true,
        sub: [":todo/title"],
        where: [
          { path: [":todo/done"], op: "=", value: false },
          { path: [":todo/rank"], op: ">=", value: 3 },
        ],
      }),
    ]);
    expect(titles(r, ":todo/_owner").sort()).toEqual(["a-open", "c-open"]);
  });

  test("or / not / and combinators", async () => {
    const or = await pull(db, ids.ada, [
      spec({
        attr: ":todo/owner",
        reverse: true,
        sub: [":todo/title"],
        where: [{ or: [{ path: [":todo/done"], op: "=", value: true }, { path: [":todo/rank"], op: "<", value: 3 }] }],
      }),
    ]);
    expect(titles(or, ":todo/_owner").sort()).toEqual(["b-done", "e-open"]);

    const not = await pull(db, ids.ada, [
      spec({
        attr: ":todo/owner",
        reverse: true,
        sub: [":todo/title"],
        where: [{ not: { path: [":todo/rank"], op: "exists" } }],
      }),
    ]);
    expect(titles(not, ":todo/_owner")).toEqual(["d-open"]);

    const and = await pull(db, ids.ada, [
      spec({
        attr: ":todo/owner",
        reverse: true,
        sub: [":todo/title"],
        where: [{ and: [{ path: [":todo/done"], op: "=", value: false }, { path: [":todo/title"], op: "includes?", value: "c-" }] }],
      }),
    ]);
    expect(titles(and, ":todo/_owner")).toEqual(["c-open"]);
  });

  test("a collection that filters to nothing is omitted; the entity survives", async () => {
    const r = await pull(db, ids.bob, [
      ":user/name",
      spec({ attr: ":todo/owner", reverse: true, sub: [":todo/title"], where: [{ path: [":todo/done"], op: "=", value: false }] }),
    ]);
    expect(r).toEqual({ ":user/name": "Bob" });
    const dflt = await pull(db, ids.bob, [
      ":user/name",
      spec({
        attr: ":todo/owner",
        reverse: true,
        sub: [":todo/title"],
        where: [{ path: [":todo/done"], op: "=", value: false }],
        default: [],
      }),
    ]);
    expect(dflt).toEqual({ ":user/name": "Bob", ":todo/_owner": [] });
  });
});

describe("nested pull: every / some quantifiers", () => {
  test("every: no reached element fails, and nothing fails when nothing is reached", async () => {
    // Ada's todos, kept when every value of the element's `:todo/title` starts
    // with its own first letter — trivially all of them
    const all = await pull(db, ids.ada, [
      spec({
        attr: ":todo/owner",
        reverse: true,
        sub: [":todo/title"],
        where: [{ every: { path: [":todo/rank"], pred: { path: [], op: ">=", value: 3 } } }],
      }),
    ]);
    // ranks: a-open 5, b-done 1, c-open 3, d-open none, e-open 2
    // d-open reaches no rank at all → vacuously true, so it is kept
    expect(titles(all, ":todo/_owner").sort()).toEqual(["a-open", "c-open", "d-open"]);
  });

  test("every over a scalar collection is the value itself", async () => {
    // Ada's tags are zeta / alpha / mid / beta: the owner's tags, walked from
    // the element. Not all of them start with "a", so `every` keeps nothing…
    const none = await pull(db, ids.ada, [
      ":user/name",
      spec({
        attr: ":todo/owner",
        reverse: true,
        sub: [":todo/title"],
        where: [{ every: { path: [":todo/owner", ":user/tags"], pred: { path: [], op: "starts-with?", value: "a" } } }],
      }),
    ]);
    expect(none).toEqual({ ":user/name": "Ada" });
    const some = await pull(db, ids.ada, [
      spec({
        attr: ":todo/owner",
        reverse: true,
        sub: [":todo/title"],
        where: [{ some: { path: [":todo/owner", ":user/tags"], pred: { path: [], op: "starts-with?", value: "a" } } }],
      }),
    ]);
    // …while `some` keeps every todo of Ada's, because "alpha" does
    expect(titles(some, ":todo/_owner").length).toBe(5);
  });

  test("a negation underneath a `some` — `∃x ¬P`, which no plain path can say", async () => {
    // Ada's todos that share a project with a todo that is *not* done.
    // Work: a-open, d-open, e-open (all open) + f-done. Home: b-done, c-open, g-open.
    const r = await pull(db, ids.ada, [
      spec({
        attr: ":todo/owner",
        reverse: true,
        sub: [":todo/title"],
        where: [
          {
            some: {
              path: [":todo/project", ":todo/project"],
              reverse: [false, true],
              pred: { not: { path: [":todo/done"], op: "=", value: true } },
            },
          },
        ],
      }),
    ]);
    expect(titles(r, ":todo/_owner").sort()).toEqual(["a-open", "b-done", "c-open", "d-open", "e-open"]);

    // `none` is the negation of that same `some`: no sibling is open
    const noneOpen = await pull(db, ids.ada, [
      ":user/name",
      spec({
        attr: ":todo/owner",
        reverse: true,
        sub: [":todo/title"],
        where: [
          {
            not: {
              some: {
                path: [":todo/project", ":todo/project"],
                reverse: [false, true],
                pred: { not: { path: [":todo/done"], op: "=", value: true } },
              },
            },
          },
        ],
      }),
    ]);
    expect(noneOpen).toEqual({ ":user/name": "Ada" });
  });

  test("every nests, and the quantifiers parse from the wire", () => {
    const parsed = parsePullPattern([
      spec({
        attr: ":user/tags",
        where: [{ every: { path: [":todo/_owner"], pred: { some: { path: [":todo/project"], pred: { path: [":project/name"], op: "=", value: "Work" } } } } }],
      }),
    ]) as PullAttrSpec[];
    expect(parsed[0].where).toEqual([
      {
        every: {
          path: [":todo/owner"],
          reverse: [true],
          pred: { some: { path: [":todo/project"], pred: { path: [":project/name"], op: "=", value: "Work" } } },
        },
      },
    ]);
    expect(() => parsePullPattern([spec({ attr: ":user/tags", where: [{ every: { path: [] } } as never] })])).toThrow(/every needs a :pred/);
  });
});

describe("nested pull: order / offset / limit", () => {
  test("asc and desc, with empty placement", async () => {
    const asc = await pull(db, ids.ada, [
      spec({ attr: ":todo/owner", reverse: true, sub: [":todo/title"], order: [{ path: [":todo/rank"], dir: "asc" }] }),
    ]);
    // d-open has no :todo/rank → empty defaults to "last" in both directions
    expect(titles(asc, ":todo/_owner")).toEqual(["b-done", "e-open", "c-open", "a-open", "d-open"]);

    const desc = await pull(db, ids.ada, [
      spec({ attr: ":todo/owner", reverse: true, sub: [":todo/title"], order: [{ path: [":todo/rank"], dir: "desc" }] }),
    ]);
    expect(titles(desc, ":todo/_owner")).toEqual(["a-open", "c-open", "e-open", "b-done", "d-open"]);

    const first = await pull(db, ids.ada, [
      spec({ attr: ":todo/owner", reverse: true, sub: [":todo/title"], order: [{ path: [":todo/rank"], dir: "asc", empty: "first" }] }),
    ]);
    expect(titles(first, ":todo/_owner")).toEqual(["d-open", "b-done", "e-open", "c-open", "a-open"]);
  });

  test("two sort keys, the second breaking ties", async () => {
    const r = await pull(db, ids.ada, [
      spec({
        attr: ":todo/owner",
        reverse: true,
        sub: [":todo/title"],
        order: [
          { path: [":todo/project", ":project/name"], dir: "asc" },
          { path: [":todo/title"], dir: "desc" },
        ],
      }),
    ]);
    expect(titles(r, ":todo/_owner")).toEqual(["c-open", "b-done", "e-open", "d-open", "a-open"]);
  });

  test("scalar collection ordered by its own values", async () => {
    const r = await pull(db, ids.ada, [spec({ attr: ":user/tags", order: [{ path: [], dir: "desc" }] })]);
    expect(r![":user/tags"]).toEqual(["zeta", "mid", "beta", "alpha"]);
  });

  test("limit applies to the filtered, sorted set — not the head of the index", async () => {
    const r = await pull(db, ids.ada, [
      spec({
        attr: ":todo/owner",
        reverse: true,
        sub: [":todo/title"],
        where: [{ path: [":todo/done"], op: "=", value: false }],
        order: [{ path: [":todo/rank"], dir: "desc" }],
        limit: 2,
      }),
    ]);
    // filtered: a-open(5) c-open(3) e-open(2) d-open(none) → desc → a-open, c-open
    expect(titles(r, ":todo/_owner")).toEqual(["a-open", "c-open"]);
    // the plain-limit path is still index order (no order key given)
    const plain = await pull(db, ids.ada, [spec({ attr: ":todo/owner", reverse: true, sub: [":todo/title"], limit: 2 })]);
    expect(titles(plain, ":todo/_owner")).toEqual(["a-open", "b-done"]);
  });

  test("offset drops from the front of the filtered, ordered collection", async () => {
    const r = await pull(db, ids.ada, [
      spec({
        attr: ":todo/owner",
        reverse: true,
        sub: [":todo/title"],
        where: [{ path: [":todo/done"], op: "=", value: false }],
        order: [{ path: [":todo/rank"], dir: "desc" }],
        offset: 1,
        limit: 2,
      }),
    ]);
    expect(titles(r, ":todo/_owner")).toEqual(["c-open", "e-open"]);
    const past = await pull(db, ids.ada, [
      ":user/name",
      spec({ attr: ":todo/owner", reverse: true, sub: [":todo/title"], offset: 99 }),
    ]);
    expect(past).toEqual({ ":user/name": "Ada" });
  });

  test("sub + where + limit on a forward ref collection", async () => {
    const r = await pull(db, ids.ada, [
      ":user/name",
      spec({
        attr: ":user/starred",
        as: "starred",
        sub: [":todo/title", { ":todo/project": [":project/name"] }],
        where: [{ path: [":todo/project", ":project/name"], op: "=", value: "Work" }],
        order: [{ path: [":todo/title"], dir: "asc" }],
        limit: 1,
      }),
    ]);
    expect(r).toEqual({
      ":user/name": "Ada",
      starred: [{ ":todo/title": "a-open", ":todo/project": { ":project/name": "Work" } }],
    });
  });
});

describe("nested pull: parse + wire", () => {
  test("AST specs pass through parsePullPattern with the new fields", () => {
    const parsed = parsePullPattern([
      spec({
        attr: ":todo/owner",
        reverse: true,
        sub: [":todo/title"],
        where: [{ path: [":todo/done"], op: "=", value: false }],
        order: [{ path: [":todo/rank"], dir: "desc", empty: "first" }],
        offset: 1,
        limit: 2,
      }),
    ]) as PullAttrSpec[];
    expect(parsed[0].where).toEqual([{ path: [":todo/done"], op: "=", value: false }]);
    expect(parsed[0].order).toEqual([{ path: [":todo/rank"], dir: "desc", empty: "first" }]);
    expect(parsed[0].offset).toBe(1);
    expect(parsed[0].limit).toBe(2);
    // JSON round-trip (the wire) keeps them
    const wire = JSON.parse(JSON.stringify(parsed));
    expect((parsePullPattern(wire) as PullAttrSpec[])[0].where).toEqual(parsed[0].where);
  });

  test("reverse hops may be spelled with the _ ident", () => {
    const parsed = parsePullPattern([
      spec({ attr: ":user/starred", where: [{ path: [":todo/_project"], op: "exists" }] }),
    ]) as PullAttrSpec[];
    expect(parsed[0].where).toEqual([{ path: [":todo/project"], reverse: [true], op: "exists" }]);
  });

  test("bad :where / :order forms are rejected at parse time", () => {
    expect(() => parsePullPattern([spec({ attr: ":user/tags", where: [{ path: [], op: "nope" } as never] })])).toThrow(/unknown pull :where op/);
    expect(() => parsePullPattern([spec({ attr: ":user/tags", where: [{ path: [], op: "in", value: "x" } as never] })])).toThrow(/in takes a vector/);
    expect(() => parsePullPattern([spec({ attr: ":user/tags", order: [{ path: [], dir: "sideways" } as never] })])).toThrow(/order direction/);
    expect(() => parsePullPattern([spec({ attr: ":user/tags", where: "nope" as never })])).toThrow(/:where must be a vector/);
  });

  test("EDN list form carries :limit / :offset / :where / :order", async () => {
    const r = await pull(
      db,
      ids.ada,
      `[(:user/tags :order [{:dir :desc}] :offset 1 :limit 2 :where [{:op ">" :value "b"}])]`,
    );
    expect(r![":user/tags"]).toEqual(["mid", "beta"]);
  });
});

describe("nested pull inside a query", () => {
  test("the outer :limit still returns N rows however the nested where filters", async () => {
    const pattern = [
      ":user/name",
      spec({
        attr: ":todo/owner",
        reverse: true,
        as: "open",
        sub: [":todo/title"],
        where: [{ path: [":todo/done"], op: "=", value: false }],
        order: [{ path: [":todo/rank"], dir: "asc" }],
      }),
    ];
    const rows = await query(db, {
      find: [["pull", "?e", pattern]],
      where: [["?e", ":user/name", "?n"]],
      order: [["?n", "asc"]],
      limit: 2,
    });
    // 3 users, limit 2 → Ada and Bob; Bob's todos all filtered out, but Bob stays
    expect(rows.length).toBe(2);
    expect(rows.map((r: any) => r[0][":user/name"])).toEqual(["Ada", "Bob"]);
    expect(rows[0][0].open.map((t: any) => t[":todo/title"])).toEqual(["e-open", "c-open", "a-open", "d-open"]);
    expect(rows[1][0].open).toBeUndefined();
  });

  test("nested limit inside a query with an outer offset", async () => {
    const pattern = [
      ":user/name",
      spec({
        attr: ":todo/owner",
        reverse: true,
        as: "top",
        sub: [":todo/title"],
        order: [{ path: [":todo/rank"], dir: "desc" }],
        limit: 1,
      }),
    ];
    const rows = await query(db, {
      find: [["pull", "?e", pattern]],
      where: [["?e", ":user/name", "?n"]],
      order: [["?n", "asc"]],
      offset: 2,
      limit: 5,
    });
    expect(rows.length).toBe(1);
    expect(rows[0][0]).toEqual({ ":user/name": "Cy", top: [{ ":todo/title": "g-open" }] });
  });
});
