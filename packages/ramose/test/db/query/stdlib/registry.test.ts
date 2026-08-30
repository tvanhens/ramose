/**
 * Allowlist, validation, and failure sealing for the v1 expression standard
 * library (#507).
 *
 * The registry is the public boundary: only manifest names resolve, arity and
 * declared argument types are enforced before anything runs, contexts are
 * honoured, and what comes back on failure carries names, declared types,
 * value kinds and counts — never a value and never an internal name.
 */

import { describe, expect, test } from "bun:test";
import * as Result from "effect/Result";
import {
  checkQueryCallArguments,
  evaluateQueryCall,
  isQueryFunctionName,
  lookupQueryFunction,
  queryFunctionNames,
  sealStdlibFailure,
  standardLibraryV1,
  validateQueryCall,
  type ExpressionContext,
  type SealedStdlibFailure,
  type StdlibFailure,
  type StdlibValue,
} from "../../../../src/db/query/stdlib/index.ts";

const failureOf = (
  name: string,
  args: readonly StdlibValue[],
  context: ExpressionContext = "let",
): StdlibFailure => {
  const outcome = evaluateQueryCall({ name, context, args });
  if (Result.isSuccess(outcome)) {
    throw new Error(`expected a failure, got ${JSON.stringify(outcome.success)}`);
  }
  return outcome.failure;
};

const sealed = (
  name: string,
  args: readonly StdlibValue[],
  context: ExpressionContext = "let",
): SealedStdlibFailure => sealStdlibFailure(failureOf(name, args, context));

describe("the allowlist is explicit", () => {
  test("an unpublished name is unknown", () => {
    for (const name of [
      "text.regex",
      "time.now",
      "number.rand",
      "collection.unnest",
      "system.exec",
      "",
      "text",
      "text.",
      ".lower",
      "TEXT.LOWER",
      "text.Lower",
      " text.lower",
      "text.lower ",
    ]) {
      expect(isQueryFunctionName(name)).toBe(false);
      expect(lookupQueryFunction(name)).toBeUndefined();
      expect(sealed(name, [])).toEqual({
        code: "query_function_unknown",
        function: name,
      });
    }
  });

  test("inherited object members are not functions", () => {
    for (const name of [
      "constructor",
      "toString",
      "hasOwnProperty",
      "__proto__",
      "valueOf",
      "prototype",
    ]) {
      expect(isQueryFunctionName(name)).toBe(false);
      expect(lookupQueryFunction(name)).toBeUndefined();
      expect(sealed(name, ["x"]).code).toBe("query_function_unknown");
    }
  });

  test("an internal-style alias is rejected the same way an unknown name is", () => {
    // Clojure/JavaScript spellings and engine symbols are not public names,
    // and the answer never confirms that some other name exists internally.
    for (const name of [
      "clojure.string/lower-case",
      "str",
      "get-else",
      "ground",
      "toLowerCase",
      "Q.call",
      "db/id",
    ]) {
      expect(sealed(name, ["x"])).toEqual({
        code: "query_function_unknown",
        function: name,
      });
    }
  });

  test("published names all resolve", () => {
    for (const name of queryFunctionNames()) {
      expect(lookupQueryFunction(name)?.name).toBe(name);
    }
  });
});

describe("arity", () => {
  test("too few and too many arguments are rejected", () => {
    expect(sealed("text.lower", [])).toEqual({
      code: "query_function_arity",
      function: "text.lower",
      expected: 1,
      received: 0,
    });
    expect(sealed("text.lower", ["a", "b"])).toEqual({
      code: "query_function_arity",
      function: "text.lower",
      expected: 1,
      received: 2,
    });
    expect(sealed("logic.if", [true, "a"])).toEqual({
      code: "query_function_arity",
      function: "logic.if",
      expected: 3,
      received: 2,
    });
  });

  test("arity is checked statically, before any argument exists", () => {
    const outcome = validateQueryCall({
      name: "text.concat",
      context: "select",
      argumentCount: 1,
    });
    expect(Result.isFailure(outcome)).toBe(true);
    if (Result.isFailure(outcome)) {
      expect(sealStdlibFailure(outcome.failure)).toEqual({
        code: "query_function_arity",
        function: "text.concat",
        expected: 2,
        received: 1,
      });
    }
  });

  test("every published function accepts exactly its declared arity", () => {
    for (const card of standardLibraryV1.functions) {
      const arity = card.signature.parameters.length;
      for (const context of card.contexts) {
        expect(
          Result.isSuccess(
            validateQueryCall({ name: card.name, context, argumentCount: arity }),
          ),
        ).toBe(true);
        expect(
          Result.isFailure(
            validateQueryCall({ name: card.name, context, argumentCount: arity + 1 }),
          ),
        ).toBe(true);
      }
    }
  });
});

describe("expression context", () => {
  test("a collection-valued call is rejected as a sort key", () => {
    expect(sealed("text.split", ["a,b", ","], "orderBy")).toEqual({
      code: "query_function_context",
      function: "text.split",
      context: "orderBy",
      allowed: ["let", "where", "select"],
    });
    expect(sealed("collection.distinct", [["a"]], "orderBy").code).toBe(
      "query_function_context",
    );
    expect(sealed("collection.concat", [["a"], ["b"]], "orderBy").code).toBe(
      "query_function_context",
    );
    expect(sealed("collection.slice", [["a"], 0, 1], "orderBy").code).toBe(
      "query_function_context",
    );
  });

  test("the same call succeeds in an admitted context", () => {
    for (const context of ["let", "where", "select"] as const) {
      const outcome = evaluateQueryCall({
        name: "text.split",
        context,
        args: ["a,b", ","],
      });
      expect(Result.isSuccess(outcome)).toBe(true);
    }
  });

  test("an unknown name loses to the allowlist before the context is consulted", () => {
    expect(sealed("collection.unnest", [["a"]], "orderBy").code).toBe(
      "query_function_unknown",
    );
  });

  test("every card admits at least one context it actually validates in", () => {
    for (const card of standardLibraryV1.functions) {
      for (const context of card.contexts) {
        expect(
          Result.isSuccess(
            validateQueryCall({
              name: card.name,
              context,
              argumentCount: card.signature.parameters.length,
            }),
          ),
        ).toBe(true);
      }
    }
  });
});

describe("argument types", () => {
  test("a wrong argument kind is reported by position and declared type", () => {
    expect(sealed("text.lower", [42])).toEqual({
      code: "query_function_argument_type",
      function: "text.lower",
      index: 0,
      parameter: "value",
      expected: "text",
      received: "number",
    });
    expect(sealed("number.add", [1, "2"])).toEqual({
      code: "query_function_argument_type",
      function: "number.add",
      index: 1,
      parameter: "right",
      expected: "number",
      received: "text",
    });
    expect(sealed("collection.size", [{ a: 1 }])).toEqual({
      code: "query_function_argument_type",
      function: "collection.size",
      index: 0,
      parameter: "value",
      expected: "collection",
      received: "object",
    });
    expect(sealed("logic.and", ["yes", true])).toEqual({
      code: "query_function_argument_type",
      function: "logic.and",
      index: 0,
      parameter: "left",
      expected: "boolean",
      received: "text",
    });
  });

  test("ill-formed text is reported as its own kind, not as text", () => {
    expect(sealed("text.lower", ["\uD800"])).toEqual({
      code: "query_function_argument_type",
      function: "text.lower",
      index: 0,
      parameter: "value",
      expected: "text",
      received: "malformedText",
    });
    expect(sealed("logic.eq", ["a", "\uDE00"])).toEqual({
      code: "query_function_argument_type",
      function: "logic.eq",
      index: 1,
      parameter: "right",
      expected: "any",
      received: "malformedText",
    });
  });

  test("a timestamp must be a whole instant in range", () => {
    expect(sealed("time.before", [1.5, 2000])).toEqual({
      code: "query_function_argument_type",
      function: "time.before",
      index: 0,
      parameter: "left",
      expected: "timestamp",
      received: "number",
    });
    expect(sealed("time.before", [8_640_000_000_000_001, 0]).code).toBe(
      "query_function_argument_type",
    );
    expect(sealed("time.before", ["2020-01-01", 0]).code).toBe(
      "query_function_argument_type",
    );
  });

  test("an `any` parameter accepts every JSON value", () => {
    for (const value of [null, true, 1, "a", [], {}] as readonly StdlibValue[]) {
      const outcome = evaluateQueryCall({
        name: "logic.isNull",
        context: "let",
        args: [value],
      });
      expect(Result.isSuccess(outcome)).toBe(true);
    }
  });

  test("absence is never a type error", () => {
    for (const card of standardLibraryV1.functions) {
      const args = card.signature.parameters.map(() => null);
      const outcome = evaluateQueryCall({
        name: card.name,
        context: card.contexts[0],
        args,
      });
      expect(Result.isSuccess(outcome)).toBe(true);
    }
  });

  test("checking arguments is available on its own", () => {
    const card = lookupQueryFunction("text.concat");
    expect(card).toBeDefined();
    if (card === undefined) return;
    expect(Result.isSuccess(checkQueryCallArguments(card, ["a", "b"]))).toBe(true);
    expect(Result.isFailure(checkQueryCallArguments(card, ["a", 1]))).toBe(true);
    expect(Result.isFailure(checkQueryCallArguments(card, ["a"]))).toBe(true);
  });
});

describe("failures are value-sealed", () => {
  const secret = "hidden-field-value-0xdeadbeef";

  test("no argument value reaches the sealed failure", () => {
    const cases: readonly SealedStdlibFailure[] = [
      sealed("text.lower", [[secret]]),
      sealed("number.add", [1, secret]),
      sealed("collection.size", [{ leak: secret }]),
      sealed("text.lower", [secret, secret]),
      sealed("text.split", [secret, ","], "orderBy"),
    ];
    for (const failure of cases) {
      expect(JSON.stringify(failure)).not.toContain(secret);
    }
  });

  test("a sealed failure carries only admitted keys", () => {
    const admitted = new Set([
      "code",
      "function",
      "expected",
      "received",
      "index",
      "parameter",
      "context",
      "allowed",
      "limit",
    ]);
    const cases: readonly SealedStdlibFailure[] = [
      sealed("nope.nope", []),
      sealed("text.lower", []),
      sealed("text.lower", [1]),
      sealed("text.split", ["a", ","], "orderBy"),
    ];
    for (const failure of cases) {
      for (const key of Object.keys(failure)) {
        expect(admitted.has(key)).toBe(true);
      }
      // Sealed failures are plain JSON, ready for the public error path.
      expect(JSON.parse(JSON.stringify(failure))).toEqual(failure);
    }
  });

  test("a type failure names the kind, never the value", () => {
    const failure = sealed("text.lower", [{ ssn: secret }]);
    expect(failure).toEqual({
      code: "query_function_argument_type",
      function: "text.lower",
      index: 0,
      parameter: "value",
      expected: "text",
      received: "object",
    });
  });

  test("failure codes are the stable public vocabulary", () => {
    expect(sealed("nope.nope", []).code).toBe("query_function_unknown");
    expect(sealed("text.lower", []).code).toBe("query_function_arity");
    expect(sealed("text.lower", [1]).code).toBe("query_function_argument_type");
    expect(sealed("text.split", ["a", ","], "orderBy").code).toBe(
      "query_function_context",
    );
    expect(
      sealed("text.replace", ["a".repeat(2_000), "a", "b".repeat(1_000)]).code,
    ).toBe("query_function_output_size");
  });
});

describe("evaluation is total", () => {
  test("no admitted call throws, whatever the argument values", () => {
    const values: readonly StdlibValue[] = [
      null,
      true,
      false,
      0,
      -0,
      1,
      -1,
      0.5,
      1e308,
      "",
      "a",
      [],
      ["a"],
      [null],
      {},
      { a: 1 },
    ];
    for (const card of standardLibraryV1.functions) {
      const arity = card.signature.parameters.length;
      for (const value of values) {
        const args = Array.from({ length: arity }, () => value);
        expect(() =>
          evaluateQueryCall({ name: card.name, context: card.contexts[0], args }),
        ).not.toThrow();
      }
    }
  });

  test("a successful result always satisfies its declared result type", () => {
    const values: readonly StdlibValue[] = [null, true, 0, -1, 1e308, "", "a", [], ["a"], [1]];
    for (const card of standardLibraryV1.functions) {
      const arity = card.signature.parameters.length;
      for (const value of values) {
        const args = Array.from({ length: arity }, () => value);
        const outcome = evaluateQueryCall({
          name: card.name,
          context: card.contexts[0],
          args,
        });
        if (!Result.isSuccess(outcome)) continue;
        const produced = outcome.success;
        if (produced === null) continue;
        if (card.signature.result === "collection") {
          expect(Array.isArray(produced)).toBe(true);
        }
        if (card.signature.result === "number" || card.signature.result === "timestamp") {
          expect(Number.isFinite(produced as number)).toBe(true);
        }
        if (card.signature.result === "text") expect(typeof produced).toBe("string");
        if (card.signature.result === "boolean") expect(typeof produced).toBe("boolean");
      }
    }
  });
});
