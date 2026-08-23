/**
 * Canonical subscription keys: lowered AST, deterministic key order,
 * params vs already-substituted queries.
 */

import { describe, expect, test } from "bun:test";
import * as Schema from "effect/Schema";
import {
  Entity,
  Field,
  Query,
  canonicalAstKey,
  liveSubscriptionKey,
  lowerQueryAst,
  params,
  paramsKey,
  queryAstKey,
} from "../../src/db/internal.ts";

const Todo = Entity("todo", {
  title: Field(Schema.String),
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

  test("a params query keys as the holed AST — bindings do not change astKey", () => {
    const p = params({ n: Schema.Number });
    const limited = Query.from(Todo).ids().limit(p.n);
    expect(queryAstKey(limited)).toBe(queryAstKey(limited));
    const ast = lowerQueryAst(limited);
    expect(JSON.stringify(ast)).toContain("$param");
    expect(JSON.stringify(ast)).toContain("\"n\"");
    expect(queryAstKey(limited)).not.toBe(queryAstKey(Query.from(Todo).ids().limit(1)));
  });

  test("an already-substituted query keys as its own AST", () => {
    const inline = Query.from(Todo).ids().limit(1);
    expect(JSON.stringify(lowerQueryAst(inline))).not.toContain("$param");
    expect(queryAstKey(inline)).toBe(canonicalAstKey(lowerQueryAst(inline)));
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
