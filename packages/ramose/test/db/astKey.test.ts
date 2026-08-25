/**
 * Canonical subscription keys: lowered AST, deterministic key order,
 * inline-literal chains.
 */

import { describe, expect, test } from "bun:test";
import * as Schema from "effect/Schema";
import { pipe } from "effect/Function";
import {
  Entity,
  Field,
  Query,
  Ref,
  assertLoweringPurity,
  again,
  canonicalAstKey,
  liveSubscriptionKey,
  lowerPullPattern,
  lowerQueryAst,
  lowerQueryObject,
  pullPatternKey,
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

  test("different inline values are different keys", () => {
    expect(queryAstKey(Query.from(Todo).ids().limit(1))).not.toBe(
      queryAstKey(Query.from(Todo).ids().limit(2)),
    );
  });

  test("queryStructureKey is the same as queryAstKey", () => {
    const q = Query.from(Todo).ids().limit(1);
    expect(queryStructureKey(q)).toBe(queryAstKey(q));
  });

  test("an inline-literal query keys as its own AST", () => {
    const inline = Query.from(Todo).ids().limit(1);
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

  test("orderBy between two filters blocks sorted-equality sharing", () => {
    // Fluent `.where` after `.orderBy` cannot lower (default select is
    // inserted before orderBy). Pipe keeps both filters as clauses, and
    // the orderBy in the middle stops applyEq from re-sorting them.
    const a = Query.q(() =>
      pipe(
        Query.entities(Todo),
        Query.is(Todo.done, false),
        Query.orderBy(Todo.rank),
        Query.is(Todo.rank, 3),
        Query.select({ id: Todo.id }),
      ),
    );
    const b = Query.q(() =>
      pipe(
        Query.entities(Todo),
        Query.is(Todo.rank, 3),
        Query.orderBy(Todo.rank),
        Query.is(Todo.done, false),
        Query.select({ id: Todo.id }),
      ),
    );
    expect(queryAstKey(a)).not.toMatch(/^\0error:/);
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

  test("two unlowerable queries with the same message share a key", () => {
    const a = Query.q(() => Query.entities(Todo)).after(null);
    const b = Query.q(() => Query.entities(Todo)).after(null);
    const ka = queryAstKey(a);
    const kb = queryAstKey(b);
    expect(ka).toMatch(/^\0error:/);
    expect(kb).toBe(ka);
    expect(queryAstKey(Query.from(Todo).after(null))).toBe(ka);
  });

  test("unlowerable queries with different messages do not share a key", () => {
    const after = Query.from(Todo).after(null);
    const badLimit = Query.from(Todo).limit(-1);
    expect(queryAstKey(after)).toMatch(/^\0error:/);
    expect(queryAstKey(badLimit)).toMatch(/^\0error:/);
    expect(queryAstKey(after)).not.toBe(queryAstKey(badLimit));
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

describe("pullPatternKey", () => {
  test("two independently built equivalent maps share a key", () => {
    expect(pullPatternKey({ title: Todo.title })).toBe(
      pullPatternKey({ title: Todo.title }),
    );
    expect(pullPatternKey({ title: Todo.title })).toBe(
      canonicalAstKey(lowerPullPattern({ title: Todo.title })),
    );
  });

  test("a hoisted object memos; a different field is a different key", () => {
    const hoisted = { title: Todo.title };
    expect(pullPatternKey(hoisted)).toBe(pullPatternKey(hoisted));
    expect(pullPatternKey({ title: Todo.title })).not.toBe(
      pullPatternKey({ done: Todo.done }),
    );
  });

  test("ident-keyed array and literate map are different keys", () => {
    expect(pullPatternKey([Todo.title])).not.toBe(
      pullPatternKey({ title: Todo.title }),
    );
  });

  test("two unlowerable again() shapes with the same message share a key", () => {
    const ka = pullPatternKey(again(1));
    const kb = pullPatternKey(again(1));
    expect(ka).toMatch(/^\0error:/);
    expect(kb).toBe(ka);
  });

  test(".optional is part of the key — required and optional maps do not collide", () => {
    expect(pullPatternKey({ title: Todo.title })).not.toBe(
      pullPatternKey({ title: Todo.title.optional }),
    );
    expect(pullPatternKey({ title: Todo.title.optional })).toBe(
      pullPatternKey({ title: Todo.title.optional }),
    );
  });

  test("nested ref.select(shape).optional is a different key from required select", () => {
    const Person = Entity("person", {
      name: Field(Schema.String),
      buddy: Field(Ref.self, { optional: true }),
    });
    const required = {
      buddy: Person.buddy.select({ name: Person.name }),
    };
    const optional = {
      buddy: Person.buddy.select({ name: Person.name }).optional,
    };
    expect(pullPatternKey(required)).not.toBe(pullPatternKey(optional));
  });
});

describe("liveSubscriptionKey", () => {
  test("different inline values do not share a key", () => {
    const view = "1/todos?asOf=&history=false&minT=";
    expect(liveSubscriptionKey(view, Query.from(Todo).ids().limit(1))).not.toBe(
      liveSubscriptionKey(view, Query.from(Todo).ids().limit(2)),
    );
    expect(liveSubscriptionKey(view, Query.from(Todo).ids().limit(1))).toBe(
      liveSubscriptionKey(view, Query.from(Todo).ids().limit(1)),
    );
  });

  test("equivalent queries share a key across object identity", () => {
    const view = "1/todos?asOf=&history=false&minT=";
    expect(liveSubscriptionKey(view, allTodos)).toBe(
      liveSubscriptionKey(view, Query.from(Todo).ids()),
    );
  });

  test("a different view is a different key", () => {
    expect(liveSubscriptionKey("view-a", allTodos)).not.toBe(
      liveSubscriptionKey("view-b", allTodos),
    );
  });
});
