/**
 * Canonical subscription keys: post-binding lowered AST, deterministic
 * key order, params vs already-substituted queries.
 */

import { describe, expect, test } from "bun:test";
import * as Schema from "effect/Schema";
import { pipe } from "effect/Function";
import {
  Entity,
  Field,
  Query,
  assertLoweringPurity,
  canonicalAstKey,
  liveSubscriptionKey,
  lowerQueryAst,
  lowerQueryObject,
  params,
  paramsKey,
  queryAstKey,
  queryStructureKey,
} from "../../src/db/internal.ts";

const Todo = Entity("todo", {
  title: Field(Schema.String),
  done: Field(Schema.Boolean),
  rank: Field(Schema.Number),
});

const allTodos = Query.from(Todo).ids();

describe("canonicalAstKey", () => {
  test("object key order does not fork the key", () => {
    expect(canonicalAstKey({ b: 1, a: 2 })).toBe(canonicalAstKey({ a: 2, b: 1 }));
    expect(canonicalAstKey({ find: [1], where: { z: 1, a: 2 } })).toBe(
      canonicalAstKey({ where: { a: 2, z: 1 }, find: [1] }),
    );
  });

  test("Date and insertion-order objects canonicalize", () => {
    const at = new Date("2026-01-01T00:00:00.000Z");
    expect(canonicalAstKey({ at, n: 1 })).toBe(canonicalAstKey({ n: 1, at }));
    expect(canonicalAstKey({ at })).not.toBe(
      canonicalAstKey({ at: new Date("2026-01-02T00:00:00.000Z") }),
    );
  });
});

describe("queryAstKey", () => {
  test("two independently built equivalent queries share a key", () => {
    expect(queryAstKey(Query.from(Todo).ids())).toBe(queryAstKey(allTodos));
    expect(queryAstKey(Query.from(Todo).ids())).toBe(
      queryAstKey(Query.from(Todo).ids()),
    );
  });

  test("a different structure is a different key", () => {
    expect(queryAstKey(Query.from(Todo).ids().limit(1))).not.toBe(
      queryAstKey(allTodos),
    );
  });

  test("a params query with bindings keys as the post-binding AST — same as the inline spelling", () => {
    const p = params({ n: Schema.Number });
    const limited = Query.from(Todo).ids().limit(p.n);
    const inline = Query.from(Todo).ids().limit(1);
    expect(queryAstKey(limited, { n: 1 })).toBe(queryAstKey(inline));
    expect(JSON.stringify(lowerQueryObject(limited, { n: 1 }).query)).not.toContain(
      "$param",
    );
    const view = "1/todos?asOf=&history=false&minT=";
    expect(liveSubscriptionKey(view, limited, { n: 1 })).toBe(
      liveSubscriptionKey(view, inline),
    );
  });

  test("different bindings are different post-binding keys", () => {
    const p = params({ n: Schema.Number });
    const limited = Query.from(Todo).ids().limit(p.n);
    expect(queryAstKey(limited, { n: 1 })).not.toBe(queryAstKey(limited, { n: 2 }));
  });

  test("queryStructureKey is the holed AST — bindings do not change it", () => {
    const p = params({ n: Schema.Number });
    const limited = Query.from(Todo).ids().limit(p.n);
    expect(queryStructureKey(limited)).toBe(queryStructureKey(limited));
    const ast = lowerQueryAst(limited);
    expect(JSON.stringify(ast)).toContain("$param");
    expect(JSON.stringify(ast)).toContain("\"n\"");
    expect(queryStructureKey(limited)).not.toBe(
      queryAstKey(Query.from(Todo).ids().limit(1)),
    );
  });

  test("an already-substituted query keys as its own AST", () => {
    const inline = Query.from(Todo).ids().limit(1);
    expect(JSON.stringify(lowerQueryAst(inline))).not.toContain("$param");
    expect(queryAstKey(inline)).toBe(canonicalAstKey(lowerQueryAst(inline)));
  });

  test("permuted where-objects share queryAstKey and live cache identity", () => {
    const a = Query.from(Todo).where({ done: false, rank: 3 });
    const b = Query.from(Todo).where({ rank: 3, done: false });
    expect(JSON.stringify(lowerQueryAst(a))).toBe(JSON.stringify(lowerQueryAst(b)));
    expect(queryAstKey(a)).toBe(queryAstKey(b));
    const view = "1/todos?asOf=&history=false&minT=";
    expect(liveSubscriptionKey(view, a)).toBe(liveSubscriptionKey(view, b));
  });

  test("orderBy between two where() calls blocks sorted-equality sharing", () => {
    const a = Query.from(Todo).where({ done: false }).orderBy(Todo.rank).where({ rank: 3 });
    const b = Query.from(Todo).where({ rank: 3 }).orderBy(Todo.rank).where({ done: false });
    expect(queryAstKey(a)).not.toBe(queryAstKey(b));
  });

  test("chained equality where() calls sort the same as one object", () => {
    const chained = Query.from(Todo).where({ done: false }).where({ rank: 3 });
    const reversed = Query.from(Todo).where({ rank: 3 }).where({ done: false });
    const one = Query.from(Todo).where({ rank: 3, done: false });
    expect(queryAstKey(chained)).toBe(queryAstKey(reversed));
    expect(queryAstKey(chained)).toBe(queryAstKey(one));
  });

  test("docs conditional spelling: where before select assembles", () => {
    let board = Query.from(Todo);
    const title = "one";
    if (title) board = board.where({ title });
    const q = board.select({ title: Todo.title });
    expect(() => lowerQueryAst(q)).not.toThrow();
    expect(JSON.stringify(lowerQueryAst(q))).toContain(":todo/title");
  });

  test("a throwing params lowering keys stably — same query and bindings, same key", () => {
    const p = params({ n: Schema.Number });
    const limited = Query.from(Todo).ids().limit(p.n);
    const bad = { extra: 1 };
    const ka = queryAstKey(limited, bad);
    const kb = queryAstKey(limited, bad);
    expect(ka).toMatch(/^\0error:/);
    expect(ka).toBe(kb);
    const view = "1/todos?asOf=&history=false&minT=";
    expect(liveSubscriptionKey(view, limited, bad)).toBe(
      liveSubscriptionKey(view, limited, bad),
    );
    expect(liveSubscriptionKey(view, limited, bad)).not.toBe(
      liveSubscriptionKey(view, limited, { extra: 2 }),
    );
  });

  test("two unlowerable queries with the same message do not share a key", () => {
    const a = Query.q(() => Query.entities(Todo)).after(null);
    const b = Query.q(() => Query.entities(Todo)).after(null);
    const ka = queryAstKey(a);
    const kb = queryAstKey(b);
    expect(ka).toMatch(/^\0error:/);
    expect(kb).toMatch(/^\0error:/);
    expect(ka).not.toBe(kb);
    expect(queryAstKey(a)).toBe(ka);
  });

  test("WeakMap memo hides an impure body; assertLoweringPurity warns", () => {
    let n = 0;
    const q = Query.q(() => pipe(Query.entities(Todo), Query.limit((n += 1))));
    const k1 = queryAstKey(q);
    const k2 = queryAstKey(q);
    expect(k1).toBe(k2);
    const wire = canonicalAstKey(lowerQueryObject(q).query);
    expect(k1).not.toBe(wire);

    const warnings: unknown[][] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    try {
      assertLoweringPurity(q);
      expect(warnings).toHaveLength(1);
      expect(String(warnings[0]![0])).toContain("query body is not pure");
    } finally {
      console.warn = orig;
    }
  });
});

describe("liveSubscriptionKey", () => {
  test("params distinguish two bindings of the same query", () => {
    const p = params({ n: Schema.Number });
    const limited = Query.from(Todo).ids().limit(p.n);
    const view = "1/todos?asOf=&history=false&minT=";
    expect(liveSubscriptionKey(view, limited, { n: 1 })).not.toBe(
      liveSubscriptionKey(view, limited, { n: 2 }),
    );
    expect(liveSubscriptionKey(view, limited, { n: 1 })).toBe(
      liveSubscriptionKey(view, limited, { n: 1 }),
    );
  });

  test("equivalent no-params queries share a key across object identity", () => {
    const view = "1/todos?asOf=&history=false&minT=";
    expect(liveSubscriptionKey(view, allTodos)).toBe(
      liveSubscriptionKey(view, Query.from(Todo).ids()),
    );
  });

  test("an empty params object is omitted — same key as no params", () => {
    expect(paramsKey({})).toBe("");
    expect(paramsKey(undefined)).toBe("");
    const view = "1/todos?asOf=&history=false&minT=";
    expect(liveSubscriptionKey(view, allTodos)).toBe(
      liveSubscriptionKey(view, allTodos, {}),
    );
  });

  test("a different view is a different key", () => {
    expect(liveSubscriptionKey("view-a", allTodos)).not.toBe(
      liveSubscriptionKey("view-b", allTodos),
    );
  });
});
