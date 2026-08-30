/**
 * `QueryDocumentV1` (#486): grammar, deterministic validation and
 * normalization, complexity and page bounds, lowering onto the existing
 * engine, result-shape derivation, stable serialization, and the typed
 * lowering seam #507 implements.
 *
 * The tiny registry below is not a test double: it is a real
 * {@link FunctionRegistryV1} whose hooks lower through the same kernel
 * (`Q`) any shipped standard library will. It exists to exercise the seam,
 * not to stand in for infrastructure — the v1 standard library itself is
 * #507's, and this module deliberately ships none.
 */

import { describe, expect, test } from "bun:test";
import * as Result from "effect/Result";
import {
  Entity,
  Field,
  Q,
  Query,
  Ref,
  Schema as DbSchema,
  Trait,
  boolean,
  int,
  lowerQueryAst,
  string,
  timestamp,
} from "../../src/db/internal.ts";
import {
  DEFAULT_QUERY_LIMITS,
  catalogFromSchema,
  compileQueryDocument,
  makeFunctionRegistry,
  queryDocumentJsonSchema,
  serializeQueryDocument,
  validateQueryDocument,
  type CompiledQueryDocumentV1,
  type FunctionDefinitionV1,
  type FunctionParameterV1,
  type LoweringApiV1,
  type OperandV1,
  type PredicateLoweringV1,
  type QueryCatalogV1,
  type ScalarLoweringV1,
  type QueryDocumentV1,
  type QueryLimitsV1,
} from "../../src/db/query/document/index.ts";
import type { AnyVar, QueryGen } from "../../src/db/query/kernel.ts";

// ── the fixture application ─────────────────────────────────────────────────

const Taggable = Trait("taggable", { tag: string({ optional: true }) });

const User = Entity("user", {
  name: string(),
  email: string({ optional: true }),
});

const Issue = Entity(
  "issue",
  {
    title: string(),
    status: string(),
    done: boolean(),
    rank: int({ optional: true }),
    createdAt: timestamp(),
    owner: Field(Ref(User), { optional: true }),
    parent: Field(Ref.self, { optional: true }),
    watchers: Field.many(Ref(User)),
  },
  { traits: [Taggable] },
);

const App = DbSchema({ user: User, issue: Issue });

const catalog = catalogFromSchema(App);

// ── a registry that exercises the seam ──────────────────────────────────────

const predicate = (
  name: string,
  params: readonly FunctionParameterV1[],
  emit: PredicateLoweringV1,
  cost = 1,
): FunctionDefinitionV1 => ({
  name,
  signature: { params, result: "boolean", contexts: ["where"], deterministic: true, cost },
  lower: { kind: "predicate", emit },
});

const valueOf = function* (api: LoweringApiV1, operand: OperandV1): QueryGen<unknown> {
  return operand.kind === "constant" ? operand.value : yield* api.bind(operand);
};

const eq: FunctionDefinitionV1 = predicate(
  "logic.eq",
  [
    { name: "left", type: "any" },
    { name: "right", type: "any" },
  ],
  function* (api, args) {
    const [left, right] = args as readonly [OperandV1, OperandV1];
    // The tightest lowering: a field compared to a constant is one pattern
    // clause — exactly what `Query.from(X).where({ f: v })` emits.
    if (left.kind === "field" && right.kind === "constant") {
      yield* Q.fact(left.focus, left.field.attr, right.value as never);
      return;
    }
    const a = yield* api.bind(left);
    const b = yield* valueOf(api, right);
    yield* Q.eq(a as never, b as never);
  },
);

const filters = (args: readonly OperandV1[]): readonly (() => QueryGen<void>)[] =>
  args.map((arg) => {
    if (arg.kind !== "predicate") throw new Error("a boolean connective takes filters");
    return arg.emit;
  });

const and: FunctionDefinitionV1 = predicate(
  "logic.and",
  [
    { name: "first", type: "boolean" },
    { name: "rest", type: "boolean", rest: true },
  ],
  function* (_api, args) {
    for (const branch of filters(args)) yield* branch();
  },
);

const or: FunctionDefinitionV1 = predicate(
  "logic.or",
  [
    { name: "first", type: "boolean" },
    { name: "rest", type: "boolean", rest: true },
  ],
  function* (_api, args) {
    yield* Q.or(...filters(args));
  },
);

const not: FunctionDefinitionV1 = predicate(
  "logic.not",
  [{ name: "of", type: "boolean" }],
  function* (_api, args) {
    yield* Q.not(filters(args)[0]!);
  },
);

const gt: FunctionDefinitionV1 = predicate(
  "number.gt",
  [
    { name: "left", type: "number" },
    { name: "right", type: "number" },
  ],
  function* (api, args) {
    const left = yield* api.bind(args[0]!);
    const right = yield* valueOf(api, args[1]!);
    yield* Q.gt(left as never, right as never);
  },
);

const includes: FunctionDefinitionV1 = predicate(
  "text.includes",
  [
    { name: "haystack", type: "string" },
    { name: "needle", type: "string" },
  ],
  function* (api, args) {
    const haystack = yield* api.bind(args[0]!);
    const needle = args[1]!;
    if (needle.kind !== "constant") throw new Error("text.includes takes a literal needle");
    yield* Q.includes(haystack as never, needle.value as string);
  },
);

/** A typed temporal predicate — the reason `{ $inst }` has to be expressible. */
const after: FunctionDefinitionV1 = predicate(
  "time.after",
  [
    { name: "left", type: "instant" },
    { name: "right", type: "instant" },
  ],
  function* (api, args) {
    const left = yield* api.bind(args[0]!);
    const right = yield* valueOf(api, args[1]!);
    yield* Q.gt(left as never, right as never);
  },
);

/** A typed reference predicate — an entity id is a plain number. */
const sameEntity: FunctionDefinitionV1 = predicate(
  "entity.is",
  [
    { name: "left", type: "ref" },
    { name: "right", type: "ref" },
  ],
  function* (api, args) {
    const left = yield* api.bind(args[0]!);
    const right = yield* valueOf(api, args[1]!);
    yield* Q.eq(left as never, right as never);
  },
);

const lowerCase: ScalarLoweringV1 = function* (api, args) {
  const value = yield* api.bind(args[0]!);
  const result: AnyVar = yield* Q.call("lower-case", value);
  return { kind: "bound", v: result };
};

const lower: FunctionDefinitionV1 = {
  name: "text.lower",
  signature: {
    params: [{ name: "of", type: "string" }],
    result: "string",
    contexts: ["let", "select", "where", "orderBy"],
    deterministic: true,
    cost: 2,
  },
  lower: { kind: "scalar", emit: lowerCase },
};

const registry = makeFunctionRegistry(1, [
  eq,
  and,
  or,
  not,
  gt,
  includes,
  lower,
  after,
  sameEntity,
]);

const options = { catalog, registry };

// ── helpers ─────────────────────────────────────────────────────────────────

const compile = (doc: unknown, limits?: QueryLimitsV1): CompiledQueryDocumentV1 => {
  const result = compileQueryDocument(doc, { ...options, ...(limits ? { limits } : {}) });
  if (Result.isFailure(result)) throw new Error(result.failure.message);
  return result.success;
};

const failure = (doc: unknown, limits?: QueryLimitsV1) => {
  const result = compileQueryDocument(doc, { ...options, ...(limits ? { limits } : {}) });
  if (Result.isSuccess(result)) throw new Error("expected the document to be rejected");
  return result.failure.issues[0]!;
};

const eqCall = (path: readonly string[], value: unknown) => ({
  call: "logic.eq",
  args: [{ field: path }, { value }],
});

// ── grammar ─────────────────────────────────────────────────────────────────

describe("the grammar", () => {
  test("an expression node carries exactly one tag", () => {
    expect(
      failure({
        version: 1,
        from: { entity: "issue" },
        where: { field: ["done"], value: true },
      }),
    ).toMatchObject({ code: "malformed" });
    expect(
      failure({ version: 1, from: { entity: "issue" }, where: {} }).code,
    ).toBe("malformed");
  });

  test("a field path is an array, never a mini-language string", () => {
    expect(
      failure({
        version: 1,
        from: { entity: "issue" },
        select: { name: { field: "owner.name" } },
      }),
    ).toMatchObject({ code: "malformed", path: ["select", "name", "field"] });
  });

  test("an unknown member is refused rather than ignored", () => {
    expect(failure({ version: 1, from: { entity: "issue" }, limit: 10 })).toMatchObject({
      code: "malformed",
    });
    expect(
      failure({ version: 1, from: { entity: "issue" }, page: { last: 3 } }),
    ).toMatchObject({ code: "malformed", path: ["page"] });
  });

  test("only version 1 compiles", () => {
    expect(failure({ version: 2, from: { entity: "issue" } })).toMatchObject({
      code: "unsupported_version",
      path: ["version"],
    });
  });

  test("a root is exactly one of entity, trait", () => {
    expect(failure({ version: 1, from: { entity: "issue", trait: "taggable" } }).code).toBe(
      "malformed",
    );
    expect(compile({ version: 1, from: { trait: "taggable" } }).document.from).toEqual({
      trait: "taggable",
    });
  });
});

// ── validation: malformed vs unknown, without breaking the seal ─────────────

describe("validation", () => {
  test("an unknown definition is one code for absent and for invisible", () => {
    const absent = failure({ version: 1, from: { entity: "ticket" } });
    expect(absent).toMatchObject({ code: "unknown_definition", path: ["from", "entity"] });

    // A catalog that hides `issue` answers exactly what a catalog that never
    // had it answers — the compiler cannot tell the two apart.
    const hiding: QueryCatalogV1 = {
      ...catalog,
      root: (root) => ("entity" in root && root.entity === "issue" ? undefined : catalog.root(root)),
    };
    const hidden = compileQueryDocument(
      { version: 1, from: { entity: "issue" } },
      { catalog: hiding, registry },
    );
    expect(Result.isFailure(hidden)).toBe(true);
    if (Result.isFailure(hidden)) {
      expect(hidden.failure.issues[0]).toEqual({
        code: "unknown_definition",
        path: ["from", "entity"],
        message: 'unknown entity "issue"',
      });
    }
  });

  test("an unknown field and an unknown function are definition failures", () => {
    expect(
      failure({ version: 1, from: { entity: "issue" }, select: { x: { field: ["nope"] } } }),
    ).toMatchObject({ code: "unknown_definition" });
    expect(
      failure({
        version: 1,
        from: { entity: "issue" },
        where: { call: "text.regex", args: [{ field: ["title"] }] },
      }),
    ).toMatchObject({ code: "unknown_definition", path: ["where", "call"] });
  });

  test("bindings are ordered and lexically scoped", () => {
    // forward reference
    expect(
      failure({
        version: 1,
        from: { entity: "issue" },
        let: [
          { as: "a", expr: { var: "b" } },
          { as: "b", expr: { field: ["title"] } },
        ],
      }),
    ).toMatchObject({ code: "malformed", path: ["let", 0, "expr", "var"] });
    // self reference — the same rule, so a cycle is unexpressible
    expect(
      failure({
        version: 1,
        from: { entity: "issue" },
        let: [{ as: "a", expr: { var: "a" } }],
      }).code,
    ).toBe("malformed");
    // duplicate
    expect(
      failure({
        version: 1,
        from: { entity: "issue" },
        let: [
          { as: "a", expr: { field: ["title"] } },
          { as: "a", expr: { field: ["status"] } },
        ],
      }),
    ).toMatchObject({ path: ["let", 1, "as"] });
  });

  test("parameters are declared, plain, and finite", () => {
    expect(
      failure({
        version: 1,
        from: { entity: "issue" },
        where: { call: "logic.eq", args: [{ field: ["title"] }, { param: "needle" }] },
      }),
    ).toMatchObject({ code: "malformed", path: ["where", "args", 1, "param"] });
    expect(
      failure({ version: 1, from: { entity: "issue" }, params: { n: Number.NaN } }),
    ).toMatchObject({ code: "malformed", path: ["params", "n"] });
  });

  test("arity, context, and argument types are checked against the registry", () => {
    expect(
      failure({
        version: 1,
        from: { entity: "issue" },
        where: { call: "logic.eq", args: [{ field: ["title"] }] },
      }),
    ).toMatchObject({ code: "malformed", path: ["where", "args"] });
    expect(
      failure({
        version: 1,
        from: { entity: "issue" },
        select: { x: { call: "logic.eq", args: [{ field: ["title"] }, { value: "a" }] } },
      }).code,
    ).toBe("malformed");
    expect(
      failure({
        version: 1,
        from: { entity: "issue" },
        where: { call: "number.gt", args: [{ field: ["title"] }, { value: 1 }] },
      }),
    ).toMatchObject({ path: ["where", "args", 0] });
  });

  test("a sort key is a field path or a binding", () => {
    expect(
      failure({
        version: 1,
        from: { entity: "issue" },
        orderBy: [{ expr: { call: "text.lower", args: [{ field: ["title"] }] } }],
      }),
    ).toMatchObject({ code: "malformed", path: ["orderBy", 0, "expr"] });
    expect(
      failure({
        version: 1,
        from: { entity: "issue" },
        orderBy: [{ expr: { field: ["watchers", "name"] } }],
      }).code,
    ).toBe("malformed");
  });

  test("paging rules are structural", () => {
    expect(
      failure({
        version: 1,
        from: { entity: "issue" },
        page: { after: "r1.abc" },
      }),
    ).toMatchObject({ code: "malformed", path: ["page"] });
    expect(
      failure({
        version: 1,
        from: { entity: "issue" },
        orderBy: [{ expr: { field: ["createdAt"] } }],
        page: { after: "r1.abc", offset: 5 },
      }).code,
    ).toBe("malformed");
    expect(
      failure({ version: 1, from: { entity: "issue" }, cardinality: "one", page: { first: 2 } }).code,
    ).toBe("malformed");
  });

  test("validation is deterministic — same input, same first issue", () => {
    const bad = { version: 1, from: { entity: "issue" }, select: { x: { field: ["nope"] } } };
    expect(failure(bad)).toEqual(failure(bad));
  });
});

// ── normalization + serialization ───────────────────────────────────────────

describe("normalization", () => {
  test("writes every default explicitly, page bound included", () => {
    const { document } = compile({ version: 1, from: { entity: "issue" } });
    expect(document).toEqual({
      version: 1,
      from: { entity: "issue" },
      params: {},
      let: [],
      where: null,
      select: null,
      orderBy: [],
      page: { first: DEFAULT_QUERY_LIMITS.defaultPageSize, after: null, offset: null },
      cardinality: "many",
    });
  });

  test("is idempotent — a normalized document validates back to itself", () => {
    const doc: QueryDocumentV1 = {
      version: 1,
      from: { entity: "issue" },
      let: [{ as: "lowered", expr: { call: "text.lower", args: [{ field: ["title"] }] } }],
      where: eqCall(["status"], "open") as never,
      select: { id: { field: ["id"] }, lowered: { var: "lowered" } },
      orderBy: [{ expr: { field: ["createdAt"] }, direction: "desc" }],
      page: { first: 10 },
    };
    const once = compile(doc).document;
    const twice = compile(once).document;
    expect(twice).toEqual(once);
    expect(serializeQueryDocument(twice)).toBe(serializeQueryDocument(once));
  });

  test("serialization is stable and independent of member order", () => {
    const a = compile({
      version: 1,
      from: { entity: "issue" },
      where: eqCall(["status"], "open"),
      select: { id: { field: ["id"] } },
    });
    const b = compile({
      select: { id: { field: ["id"] } },
      where: eqCall(["status"], "open"),
      from: { entity: "issue" },
      version: 1,
    });
    expect(b.serialized).toBe(a.serialized);
    expect(a.serialized.startsWith('{"version":1,"from":{"entity":"issue"}')).toBe(true);
    // and a plain-data value inside the document keys deterministically
    const withValue = compile({
      version: 1,
      from: { entity: "issue" },
      params: { filter: { b: 2, a: 1 } },
      where: eqCall(["status"], "open"),
    });
    expect(withValue.serialized).toContain('"filter":{"a":1,"b":2}');
  });

  test("normalization defaults direction and empty on every sort key", () => {
    const { document } = compile({
      version: 1,
      from: { entity: "issue" },
      orderBy: [{ expr: { field: ["createdAt"] } }],
    });
    expect(document.orderBy).toEqual([
      { expr: { field: ["createdAt"] }, direction: "asc", empty: "last" },
    ]);
  });
});

// ── complexity and page bounds ──────────────────────────────────────────────

describe("complexity accounting", () => {
  test("counts nested projections and expression trees, at every depth", () => {
    const { complexity } = compile({
      version: 1,
      from: { entity: "issue" },
      select: {
        id: { field: ["id"] },
        owner: { path: ["owner"], select: { id: { field: ["id"] }, name: { field: ["name"] } } },
      },
      where: {
        call: "logic.and",
        args: [eqCall(["status"], "open"), { call: "logic.not", args: [eqCall(["done"], true)] }],
      },
      page: { first: 10 },
    });
    expect(complexity.projectionNodes).toBe(4);
    expect(complexity.projectionDepth).toBe(2);
    expect(complexity.traversals).toBe(1);
    expect(complexity.callCount).toBe(4);
    expect(complexity.expressionDepth).toBe(4);
    expect(complexity.pageSize).toBe(10);
    expect(complexity.cost).toBe(complexity.rowCost * 10);
  });

  test("nesting cannot smuggle work past the bound", () => {
    const deep = (depth: number): unknown =>
      depth === 0
        ? { id: { field: ["id"] } }
        : { id: { field: ["id"] }, parent: { path: ["parent"], select: deep(depth - 1) } };
    // The nested projection is inside `select`, not at the top level, and it
    // is still what trips the depth bound.
    expect(
      failure({ version: 1, from: { entity: "issue" }, select: deep(5) }),
    ).toMatchObject({ code: "budget_exceeded" });
  });

  test("page bounds are checked before execution", () => {
    expect(
      failure({ version: 1, from: { entity: "issue" }, page: { first: 10_000 } }),
    ).toMatchObject({ code: "budget_exceeded" });
    const tight: QueryLimitsV1 = { ...DEFAULT_QUERY_LIMITS, maxCost: 10 };
    expect(failure({ version: 1, from: { entity: "issue" } }, tight)).toMatchObject({
      code: "budget_exceeded",
    });
  });

  test("a call's declared cost is charged per row", () => {
    const plain = compile({
      version: 1,
      from: { entity: "issue" },
      select: { id: { field: ["id"] } },
      page: { first: 1 },
    });
    const called = compile({
      version: 1,
      from: { entity: "issue" },
      select: { id: { field: ["id"] } },
      let: [{ as: "l", expr: { call: "text.lower", args: [{ field: ["title"] }] } }],
      page: { first: 1 },
    });
    expect(called.complexity.cost).toBeGreaterThan(plain.complexity.cost);
  });
});

// ── lowering onto the existing engine ───────────────────────────────────────

describe("lowering", () => {
  test("an entity root with a filter, a projection and a limit matches the fluent builder", () => {
    const document = compile({
      version: 1,
      from: { entity: "issue" },
      where: eqCall(["status"], "open"),
      select: { id: { field: ["id"] }, title: { field: ["title"] } },
      page: { first: 25 },
    });
    const fluent = Query.from(Issue)
      .where({ status: "open" })
      .select({ id: Issue.id, title: Issue.title })
      .limit(25);
    expect(lowerQueryAst(document.query)).toEqual(lowerQueryAst(fluent));
  });

  test("a select-less document is the same full-entity row", () => {
    const document = compile({ version: 1, from: { entity: "issue" }, page: { first: 100 } });
    expect(lowerQueryAst(document.query)).toEqual(lowerQueryAst(Query.from(Issue).limit(100)));
  });

  test("nested projections lower to the pull shape", () => {
    const document = compile({
      version: 1,
      from: { entity: "issue" },
      select: {
        id: { field: ["id"] },
        owner: { path: ["owner"], select: { name: { field: ["name"] } } },
      },
      page: { first: 5 },
    });
    const fluent = Query.from(Issue)
      .select({ id: Issue.id, owner: Issue.owner.select({ name: User.name }).optional })
      .limit(5);
    expect(lowerQueryAst(document.query)).toEqual(lowerQueryAst(fluent));
  });

  test("expression-based ordering and keyset pagination lower to the engine's cursor", () => {
    const document = compile({
      version: 1,
      from: { entity: "issue" },
      select: { id: { field: ["id"] }, title: { field: ["title"] } },
      orderBy: [{ expr: { field: ["createdAt"] }, direction: "desc" }],
      page: { first: 25 },
    });
    const fluent = Query.from(Issue)
      .select({ id: Issue.id, title: Issue.title })
      .orderBy(Issue.createdAt, "desc")
      .limit(25)
      .after(null);
    expect(lowerQueryAst(document.query)).toEqual(lowerQueryAst(fluent));
    expect(document.resultShape.paged).toBe(true);
  });

  test("a cursor from one query does not continue another", () => {
    const first = compile({
      version: 1,
      from: { entity: "issue" },
      select: { id: { field: ["id"] } },
      orderBy: [{ expr: { field: ["createdAt"] } }],
      page: { first: 2 },
    });
    const cursor = Query.encodeCursor(first.query, {
      _tag: "Cursor",
      keys: [new Date(0), 1],
    } as never);
    expect(() =>
      compile({
        version: 1,
        from: { entity: "issue" },
        select: { id: { field: ["id"] } },
        orderBy: [{ expr: { field: ["createdAt"] } }],
        page: { first: 2, after: cursor },
      }),
    ).not.toThrow();
    expect(
      failure({
        version: 1,
        from: { entity: "issue" },
        select: { id: { field: ["id"] } },
        orderBy: [{ expr: { field: ["createdAt"] } }, { expr: { field: ["title"] } }],
        page: { first: 2, after: cursor },
      }),
    ).toMatchObject({ code: "malformed", path: ["page", "after"] });
  });

  test("boolean composition lowers through the registry, not a wire operator", () => {
    const document = compile({
      version: 1,
      from: { entity: "issue" },
      select: { id: { field: ["id"] } },
      where: {
        call: "logic.and",
        args: [
          eqCall(["status"], "open"),
          { call: "logic.or", args: [eqCall(["done"], false), eqCall(["tag"], "urgent")] },
          { call: "logic.not", args: [eqCall(["title"], "spam")] },
        ],
      },
      page: { first: 5 },
    });
    const ast = lowerQueryAst(document.query) as { where: unknown[] };
    const text = JSON.stringify(ast.where);
    expect(text).toContain(":issue/status");
    expect(text).toContain("or");
    expect(text).toContain("not");
  });

  test("a one-cardinality document unwraps a single row", () => {
    const document = compile({
      version: 1,
      from: { entity: "issue" },
      where: eqCall(["id"], 42),
      select: { id: { field: ["id"] } },
      cardinality: "one",
    });
    expect((lowerQueryAst(document.query) as { limit?: number }).limit).toBe(1);
    expect(document.resultShape.cardinality).toBe("one");
    expect(document.resultShape.paged).toBe(false);
  });

  test("a trait root scans every composing type", () => {
    const document = compile({
      version: 1,
      from: { trait: "taggable" },
      select: { id: { field: ["id"] }, tag: { field: ["tag"] } },
      page: { first: 5 },
    });
    expect(JSON.stringify(lowerQueryAst(document.query))).toContain("ramose-trait?");
  });

  test("lowering is deterministic", () => {
    const doc = {
      version: 1,
      from: { entity: "issue" },
      where: eqCall(["status"], "open"),
      select: { id: { field: ["id"] } },
      page: { first: 5 },
    };
    expect(lowerQueryAst(compile(doc).query)).toEqual(lowerQueryAst(compile(doc).query));
  });
});

// ── the #507 seam ───────────────────────────────────────────────────────────

describe("the expression lowering seam", () => {
  test("a scalar function binds a value later positions reuse", () => {
    const document = compile({
      version: 1,
      from: { entity: "issue" },
      params: { needle: "refund" },
      let: [
        { as: "lowered", expr: { call: "text.lower", args: [{ field: ["title"] }] } },
      ],
      where: { call: "text.includes", args: [{ var: "lowered" }, { param: "needle" }] },
      select: { id: { field: ["id"] }, lowered: { var: "lowered" } },
      orderBy: [{ expr: { var: "lowered" } }],
      page: { first: 5 },
    });
    const ast = lowerQueryAst(document.query) as {
      find: unknown[];
      where: unknown[];
      order: unknown[];
    };
    const text = JSON.stringify(ast.where);
    expect(text).toContain("lower-case");
    expect(text).toContain("includes?");
    expect(text).toContain("refund");
    // the derived value reaches the row beside the pulled entity fields
    expect(JSON.stringify(ast.find)).toContain("pull");
    expect(ast.order.length).toBeGreaterThan(0);
    expect(document.resultShape.row).toMatchObject({
      kind: "object",
      fields: { lowered: { kind: "scalar", type: "string", optional: false } },
    });
  });

  test("a registry is an allowlist — nothing resolves without it", () => {
    const bare = makeFunctionRegistry(0, []);
    const result = compileQueryDocument(
      { version: 1, from: { entity: "issue" }, where: eqCall(["status"], "open") },
      { catalog, registry: bare },
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.issues[0]!.code).toBe("unknown_definition");
    }
  });

  test("the registry rejects a predicate that claims a value context", () => {
    expect(() =>
      makeFunctionRegistry(1, [
        {
          name: "logic.bad",
          signature: {
            params: [],
            result: "boolean",
            contexts: ["select"],
            deterministic: true,
            cost: 1,
          },
          lower: { kind: "predicate", emit: function* (): QueryGen<void> {} },
        },
      ]),
    ).toThrow(/only context is "where"/);
    expect(() =>
      makeFunctionRegistry(1, [
        {
          name: "notnamespaced",
          signature: { params: [], result: "boolean", contexts: ["where"], deterministic: true, cost: 1 },
          lower: { kind: "predicate", emit: function* (): QueryGen<void> {} },
        },
      ]),
    ).toThrow(/namespaced/);
  });

  test("a registry publishes its definitions for capability projection", () => {
    expect(registry.list().map((d) => d.name)).toEqual([
      "entity.is",
      "logic.and",
      "logic.eq",
      "logic.not",
      "logic.or",
      "number.gt",
      "text.includes",
      "text.lower",
      "time.after",
    ]);
    expect(registry.lookup("text.lower")?.signature.contexts).toContain("select");
  });
});

// ── result shape ────────────────────────────────────────────────────────────

describe("result-shape derivation", () => {
  test("the default row mirrors the entity", () => {
    const { resultShape } = compile({ version: 1, from: { entity: "issue" } });
    expect(resultShape.cardinality).toBe("many");
    expect(resultShape.row).toMatchObject({
      kind: "object",
      fields: {
        id: { kind: "scalar", type: "ref", optional: false },
        title: { kind: "scalar", type: "string", optional: false },
        rank: { kind: "scalar", type: "number", optional: true },
        owner: { kind: "reference", entity: "user", optional: true },
        watchers: { kind: "list", element: { kind: "reference", entity: "user" } },
      },
    });
  });

  test("a projection carries nested objects, lists, and derived values", () => {
    const { resultShape } = compile({
      version: 1,
      from: { entity: "issue" },
      let: [{ as: "lowered", expr: { call: "text.lower", args: [{ field: ["title"] }] } }],
      select: {
        id: { field: ["id"] },
        lowered: { var: "lowered" },
        owner: { path: ["owner"], select: { name: { field: ["name"] } } },
        watchers: { path: ["watchers"], select: { name: { field: ["name"] } } },
      },
      page: { first: 5 },
    });
    expect(resultShape.row).toEqual({
      kind: "object",
      optional: false,
      fields: {
        id: { kind: "scalar", type: "ref", optional: false },
        lowered: { kind: "scalar", type: "string", optional: false },
        owner: {
          kind: "object",
          optional: true,
          fields: { name: { kind: "scalar", type: "string", optional: false } },
        },
        watchers: {
          kind: "list",
          element: {
            kind: "object",
            optional: false,
            fields: { name: { kind: "scalar", type: "string", optional: false } },
          },
        },
      },
    });
  });
});

// ── the published schema ────────────────────────────────────────────────────

describe("the JSON Schema", () => {
  test("is 2020-12, canonically identified, and free of transport concerns", () => {
    expect(queryDocumentJsonSchema.$schema).toBe(
      "https://json-schema.org/draft/2020-12/schema",
    );
    expect(queryDocumentJsonSchema.$id).toBe("https://ramose.ai/schema/query-document-v1.json");
    const text = JSON.stringify(queryDocumentJsonSchema);
    expect(text.toLowerCase()).not.toContain("mcp");
  });

  test("every expression branch forbids a second tag", () => {
    for (const branch of queryDocumentJsonSchema.$defs.expression.oneOf) {
      expect(branch.additionalProperties).toBe(false);
      expect(branch.required.length).toBeGreaterThan(0);
    }
  });

  test("covers every grammar node", () => {
    expect(Object.keys(queryDocumentJsonSchema.$defs).sort()).toEqual([
      "binding",
      "expression",
      "fieldPath",
      "nested",
      "order",
      "page",
      "params",
      "projection",
      "root",
      "selection",
    ]);
  });
});

// ── the visibility seal reaches the compiled plan ───────────────────────────

describe("catalog visibility", () => {
  /** A catalog that hides one field, the way a capability projection does. */
  const hidingRank: QueryCatalogV1 = {
    ...catalog,
    field: (owner, key) =>
      owner === Issue && key === "rank" ? undefined : catalog.field(owner, key),
  };

  const compiledWith = (cat: QueryCatalogV1, doc: unknown): string => {
    const result = compileQueryDocument(doc, { catalog: cat, registry });
    if (Result.isFailure(result)) throw new Error(result.failure.message);
    return JSON.stringify(lowerQueryAst(result.success.query));
  };

  test("a hidden field never reaches the compiled pull of a select-less document", () => {
    const doc = { version: 1, from: { entity: "issue" } };
    // the unfiltered catalog does project it — so the assertion below is
    // about the filter, not about the field being absent from the schema
    expect(compiledWith(catalog, doc)).toContain(":issue/rank");
    expect(compiledWith(hidingRank, doc)).not.toContain(":issue/rank");
    // and the rest of the row is still there
    expect(compiledWith(hidingRank, doc)).toContain(":issue/title");
  });

  test("the compiled plan and the derived result shape agree about what is visible", () => {
    const result = compileQueryDocument(
      { version: 1, from: { entity: "issue" } },
      { catalog: hidingRank, registry },
    );
    if (Result.isFailure(result)) throw new Error(result.failure.message);
    const row = result.success.resultShape.row as { fields: Record<string, unknown> };
    expect("rank" in row.fields).toBe(false);
    expect("title" in row.fields).toBe(true);
  });

  test("naming a hidden field is an unknown definition, not a leak", () => {
    const result = compileQueryDocument(
      { version: 1, from: { entity: "issue" }, select: { r: { field: ["rank"] } } },
      { catalog: hidingRank, registry },
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.issues[0]).toEqual({
        code: "unknown_definition",
        path: ["select", "r", "field", 0],
        message: 'unknown field "rank"',
      });
    }
  });
});

// ── boolean parameters are always filter positions ──────────────────────────

describe("nested boolean expressions", () => {
  const whereText = (where: unknown): string => {
    const document = compile({
      version: 1,
      from: { entity: "issue" },
      select: { id: { field: ["id"] } },
      where,
      page: { first: 5 },
    });
    return JSON.stringify((lowerQueryAst(document.query) as { where: unknown[] }).where);
  };

  test("a bare boolean field in a predicate parameter is a filter, not an operand", () => {
    const text = whereText({ call: "logic.not", args: [{ field: ["done"] }] });
    expect(text).toContain("not");
    expect(text).toContain(":issue/done");
  });

  test("a connective mixes bare fields and nested calls", () => {
    const text = whereText({
      call: "logic.and",
      args: [{ field: ["done"] }, eqCall(["status"], "open")],
    });
    expect(text).toContain(":issue/done");
    expect(text).toContain(":issue/status");
  });

  test("a bound boolean binding is a filter in predicate position", () => {
    const document = compile({
      version: 1,
      from: { entity: "issue" },
      let: [{ as: "isDone", expr: { field: ["done"] } }],
      select: { id: { field: ["id"] } },
      where: { call: "logic.not", args: [{ var: "isDone" }] },
      page: { first: 5 },
    });
    const text = JSON.stringify((lowerQueryAst(document.query) as { where: unknown[] }).where);
    expect(text).toContain("not");
    expect(text).toContain(":issue/done");
  });

  test("a non-boolean expression in a predicate parameter is still refused", () => {
    expect(
      failure({
        version: 1,
        from: { entity: "issue" },
        where: { call: "logic.not", args: [{ field: ["title"] }] },
      }),
    ).toMatchObject({ code: "malformed", path: ["where", "args", 0] });
  });
});

// ── typed value encodings ───────────────────────────────────────────────────

describe("value encodings", () => {
  test("an instant literal satisfies an instant parameter and reaches the plan", () => {
    const document = compile({
      version: 1,
      from: { entity: "issue" },
      select: { id: { field: ["id"] } },
      where: {
        call: "time.after",
        args: [{ field: ["createdAt"] }, { value: { $inst: 1767225600000 } }],
      },
      page: { first: 5 },
    });
    expect(JSON.stringify(lowerQueryAst(document.query))).toContain("2026-01-01T00:00:00.000Z");
  });

  test("an ISO instant normalizes to the canonical epoch form", () => {
    const { document, serialized } = compile({
      version: 1,
      from: { entity: "issue" },
      select: { id: { field: ["id"] } },
      where: {
        call: "time.after",
        args: [{ field: ["createdAt"] }, { value: { $inst: "2026-01-01T00:00:00.000Z" } }],
      },
      page: { first: 5 },
    });
    expect(serialized).toContain('{"$inst":1767225600000}');
    // and the normalized form is a fixed point
    expect(compile(document).serialized).toBe(serialized);
  });

  test("a bare string is not an instant", () => {
    expect(
      failure({
        version: 1,
        from: { entity: "issue" },
        where: {
          call: "time.after",
          args: [{ field: ["createdAt"] }, { value: "2026-01-01T00:00:00.000Z" }],
        },
      }),
    ).toMatchObject({ code: "malformed", path: ["where", "args", 1] });
  });

  test("an entity id is a plain number in a reference position", () => {
    expect(() =>
      compile({
        version: 1,
        from: { entity: "issue" },
        select: { id: { field: ["id"] } },
        where: { call: "entity.is", args: [{ field: ["owner"] }, { value: 7 }] },
        page: { first: 5 },
      }),
    ).not.toThrow();
    expect(
      failure({
        version: 1,
        from: { entity: "issue" },
        where: { call: "entity.is", args: [{ field: ["owner"] }, { value: "seven" }] },
      }),
    ).toMatchObject({ path: ["where", "args", 1] });
  });

  test("uuid and bytes literals are validated and canonicalized", () => {
    const { serialized } = compile({
      version: 1,
      from: { entity: "issue" },
      params: {
        token: { $uuid: "3F2504E0-4F89-11D3-9A0C-0305E82C3301" },
        blob: { $bytes: "AAEC" },
      },
      select: { id: { field: ["id"] } },
      page: { first: 5 },
    });
    expect(serialized).toContain('"token":{"$uuid":"3f2504e0-4f89-11d3-9a0c-0305e82c3301"}');
    expect(serialized).toContain('"blob":{"$bytes":"AAEC"}');
    expect(
      failure({ version: 1, from: { entity: "issue" }, params: { t: { $uuid: "nope" } } }),
    ).toMatchObject({ code: "malformed", path: ["params", "t"] });
    expect(
      failure({ version: 1, from: { entity: "issue" }, params: { b: { $bytes: "!!!" } } }),
    ).toMatchObject({ code: "malformed", path: ["params", "b"] });
  });

  test("every other $-prefixed key is reserved, so a later tag cannot reinterpret a document", () => {
    expect(
      failure({ version: 1, from: { entity: "issue" }, params: { p: { $ref: 7 } } }),
    ).toMatchObject({ code: "malformed", path: ["params", "p", "$ref"] });
    expect(
      failure({
        version: 1,
        from: { entity: "issue" },
        where: eqCall(["title"], { $future: 1 }),
      }).code,
    ).toBe("malformed");
    // a plain object is still ordinary opaque JSON
    expect(() =>
      compile({
        version: 1,
        from: { entity: "issue" },
        params: { p: { a: 1, b: [2, 3] } },
        select: { id: { field: ["id"] } },
        page: { first: 5 },
      }),
    ).not.toThrow();
  });

  test("the published schema states the encoding", () => {
    const text = JSON.stringify(queryDocumentJsonSchema);
    expect(text).toContain("$inst");
    expect(text).toContain("$bytes");
    expect(text).toContain("$uuid");
    expect(text).toContain("reserved");
  });
});

// ── a row always has an entity behind it ────────────────────────────────────

describe("derived-only projections", () => {
  test("are refused, so no document compiles into a focus-less row", () => {
    expect(
      failure({
        version: 1,
        from: { entity: "issue" },
        let: [{ as: "lowered", expr: { call: "text.lower", args: [{ field: ["title"] }] } }],
        select: { lowered: { var: "lowered" } },
        orderBy: [{ expr: { field: ["createdAt"] } }],
        page: { first: 5 },
      }),
    ).toMatchObject({ code: "malformed", path: ["select"] });
    expect(
      failure({
        version: 1,
        from: { entity: "issue" },
        select: { constant: { value: 1 } },
      }),
    ).toMatchObject({ code: "malformed", path: ["select"] });
  });

  test("one field is enough to keep the focus, and it pages", () => {
    const document = compile({
      version: 1,
      from: { entity: "issue" },
      let: [{ as: "lowered", expr: { call: "text.lower", args: [{ field: ["title"] }] } }],
      select: { id: { field: ["id"] }, lowered: { var: "lowered" } },
      orderBy: [{ expr: { field: ["createdAt"] } }],
      page: { first: 5 },
    });
    const ast = lowerQueryAst(document.query) as { order: { var: string }[] };
    // the keyset tie-breaker exists, which is only possible with a focus
    expect(ast.order.length).toBe(2);
    expect(document.resultShape.paged).toBe(true);
  });
});

// ── the module boundary ─────────────────────────────────────────────────────

describe("the module boundary", () => {
  test("the namespace is reachable through the published `ramose/db` barrel", async () => {
    const db = (await import("../../src/db/index.ts")) as Record<string, unknown>;
    expect("QueryDocument" in db).toBe(true);
    const namespace = db["QueryDocument"] as Record<string, unknown>;
    for (const name of [
      "compileQueryDocument",
      "validateQueryDocument",
      "queryDocumentJsonSchema",
      "catalogFromSchema",
      "makeFunctionRegistry",
      "serializeQueryDocument",
      "QUERY_DOCUMENT_VERSION",
      "DEFAULT_QUERY_LIMITS",
    ]) {
      expect(name in namespace).toBe(true);
    }
  });

  test("validation without lowering answers the same normalized document", () => {
    const doc = {
      version: 1,
      from: { entity: "issue" },
      where: eqCall(["status"], "open"),
      page: { first: 5 },
    };
    const validated = validateQueryDocument(doc, options);
    expect(Result.isSuccess(validated)).toBe(true);
    if (Result.isSuccess(validated)) {
      expect(validated.success.document).toEqual(compile(doc).document);
      expect(validated.success.serialized).toBe(compile(doc).serialized);
    }
  });
});
