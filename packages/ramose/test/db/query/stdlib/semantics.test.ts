import { describe, expect, test } from "bun:test";
import * as Result from "effect/Result";
import {
  MAX_PRODUCED_TEXT_UNITS,
  MAX_TIMESTAMP_MILLIS,
  MAX_VALUE_DEPTH,
  asciiLower,
  asciiUpper,
  canonicalKey,
  classify,
  deepEquals,
  domainViolation,
  evaluateQueryCall,
  isWellFormedText,
  matchesValueType,
  sealStdlibFailure,
  standardLibraryV1,
  trimPinned,
  type ExpressionContext,
  type StdlibValue,
} from "../../../../src/db/query/stdlib/index.ts";

const call = (
  name: string,
  args: readonly StdlibValue[],
  context: ExpressionContext = "let",
): StdlibValue => {
  const outcome = evaluateQueryCall({ name, context, args });
  if (Result.isFailure(outcome)) {
    throw new Error(
      `unexpected failure: ${JSON.stringify(sealStdlibFailure(outcome.failure))}`,
    );
  }
  return outcome.success;
};

const failureCode = (
  name: string,
  args: readonly StdlibValue[],
  context: ExpressionContext = "let",
): string => {
  const outcome = evaluateQueryCall({ name, context, args });
  if (Result.isSuccess(outcome)) {
    throw new Error(`expected a failure, got ${JSON.stringify(outcome.success)}`);
  }
  return sealStdlibFailure(outcome.failure).code;
};

const nest = (depth: number): StdlibValue => {
  let value: StdlibValue = 1;
  for (let i = 0; i < depth; i += 1) value = [value];
  return value;
};

describe("value helpers", () => {
  test("classify names the kind of a value, not its contents", () => {
    expect(classify(null)).toBe("null");
    expect(classify(true)).toBe("boolean");
    expect(classify(1)).toBe("number");
    expect(classify("x")).toBe("text");
    expect(classify([])).toBe("collection");
    expect(classify({})).toBe("object");
  });

  test("a string with an unpaired surrogate is not text", () => {
    expect(classify("😀")).toBe("text");
    expect(classify("\uD800")).toBe("malformedText");
    expect(classify("\uDE00")).toBe("malformedText");
    expect(classify("a\uD800b")).toBe("malformedText");
    expect(classify("a\uD83D")).toBe("malformedText");
  });

  test("well-formedness accepts paired surrogates and rejects lone ones", () => {
    expect(isWellFormedText("")).toBe(true);
    expect(isWellFormedText("abc")).toBe(true);
    expect(isWellFormedText("😀")).toBe(true);
    expect(isWellFormedText("a😀b")).toBe(true);
    expect(isWellFormedText("\uD800")).toBe(false);
    expect(isWellFormedText("\uDFFF")).toBe(false);
    expect(isWellFormedText("\uD800\uD800")).toBe(false);
    expect(isWellFormedText("😀\uD800")).toBe(false);
  });

  test("ill-formed text satisfies no declared type, `any` included", () => {
    for (const type of ["any", "text", "boolean", "number", "collection"] as const) {
      expect(matchesValueType("\uD800", type)).toBe(false);
    }
    expect(matchesValueType("😀", "text")).toBe(true);
  });

  test("case mapping is ASCII only, so no host Unicode table can move it", () => {
    expect(asciiLower("Refund")).toBe("refund");
    expect(asciiUpper("refund")).toBe("REFUND");
    expect(asciiLower("ÄÖÜ")).toBe("ÄÖÜ");
    expect(asciiUpper("straße")).toBe("STRAßE");

    expect(asciiLower("\u1C89")).toBe("\u1C89");
    expect(asciiUpper("\u1C8A")).toBe("\u1C8A");
    expect(asciiLower("A1[]~")).toBe("a1[]~");
    expect(asciiUpper("a1[]~")).toBe("A1[]~");
    expect(asciiLower("😀")).toBe("😀");
  });

  test("the trimmed whitespace set is pinned, not the host's", () => {
    const pinned =
      "\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000\u200A" +
      "\u2028\u2029\u202F\u205F\u3000\uFEFF";
    expect(trimPinned(`${pinned}hi${pinned}`)).toBe("hi");
    expect(trimPinned("  hi  ")).toBe("hi");
    expect(trimPinned("hi there")).toBe("hi there");
    expect(trimPinned("")).toBe("");
    expect(trimPinned(pinned)).toBe("");

    expect(trimPinned("\u200Bhi\u200B")).toBe("\u200Bhi\u200B");
  });

  test("null satisfies every declared type", () => {
    for (const type of ["any", "boolean", "number", "timestamp", "text", "collection"] as const) {
      expect(matchesValueType(null, type)).toBe(true);
    }
  });

  test("a timestamp is a safe integer inside the representable range", () => {
    expect(matchesValueType(0, "timestamp")).toBe(true);
    expect(matchesValueType(MAX_TIMESTAMP_MILLIS, "timestamp")).toBe(true);
    expect(matchesValueType(-MAX_TIMESTAMP_MILLIS, "timestamp")).toBe(true);
    expect(matchesValueType(MAX_TIMESTAMP_MILLIS + 1, "timestamp")).toBe(false);
    expect(matchesValueType(1.5, "timestamp")).toBe(false);
  });

  test("deep equality is structural and key-order independent", () => {
    expect(deepEquals({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(deepEquals([1, [2]], [1, [2]])).toBe(true);
    expect(deepEquals([1, 2], [2, 1])).toBe(false);
    expect(deepEquals(0, -0)).toBe(true);
    expect(deepEquals(1, "1")).toBe(false);
    expect(deepEquals(null, null)).toBe(true);
    expect(deepEquals(null, 0)).toBe(false);
    expect(deepEquals({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });

  test("canonical keys separate kinds and ignore object key order", () => {
    expect(canonicalKey({ a: 1, b: 2 })).toBe(canonicalKey({ b: 2, a: 1 }));
    expect(canonicalKey(1)).not.toBe(canonicalKey("1"));
    expect(canonicalKey(0)).toBe(canonicalKey(-0));
    expect(canonicalKey(true)).not.toBe(canonicalKey(1));
    expect(canonicalKey(null)).not.toBe(canonicalKey("z"));
  });
});

describe("logic", () => {
  test("and is Kleene three-valued", () => {
    expect(call("logic.and", [true, true])).toBe(true);
    expect(call("logic.and", [true, false])).toBe(false);
    expect(call("logic.and", [false, false])).toBe(false);
    expect(call("logic.and", [false, null])).toBe(false);
    expect(call("logic.and", [null, false])).toBe(false);
    expect(call("logic.and", [true, null])).toBe(null);
    expect(call("logic.and", [null, null])).toBe(null);
  });

  test("or is Kleene three-valued", () => {
    expect(call("logic.or", [true, null])).toBe(true);
    expect(call("logic.or", [null, true])).toBe(true);
    expect(call("logic.or", [false, false])).toBe(false);
    expect(call("logic.or", [false, null])).toBe(null);
    expect(call("logic.or", [null, null])).toBe(null);
  });

  test("not leaves unknown unknown", () => {
    expect(call("logic.not", [true])).toBe(false);
    expect(call("logic.not", [false])).toBe(true);
    expect(call("logic.not", [null])).toBe(null);
  });

  test("eq and ne compare structurally and propagate absence", () => {
    expect(call("logic.eq", ["a", "a"])).toBe(true);
    expect(call("logic.eq", [{ a: [1] }, { a: [1] }])).toBe(true);
    expect(call("logic.eq", [1, "1"])).toBe(false);
    expect(call("logic.eq", [null, "a"])).toBe(null);
    expect(call("logic.eq", [null, null])).toBe(null);
    expect(call("logic.ne", ["a", "b"])).toBe(true);
    expect(call("logic.ne", [null, "b"])).toBe(null);
  });

  test("isNull answers about absence and never returns unknown", () => {
    expect(call("logic.isNull", [null])).toBe(true);
    expect(call("logic.isNull", [""])).toBe(false);
    expect(call("logic.isNull", [0])).toBe(false);
    expect(call("logic.isNull", [false])).toBe(false);
    expect(call("logic.isNull", [[]])).toBe(false);
  });

  test("coalesce only replaces absence", () => {
    expect(call("logic.coalesce", [null, "fallback"])).toBe("fallback");
    expect(call("logic.coalesce", ["", "fallback"])).toBe("");
    expect(call("logic.coalesce", [false, "fallback"])).toBe(false);
    expect(call("logic.coalesce", [null, null])).toBe(null);
  });

  test("if takes the false branch for false and for unknown", () => {
    expect(call("logic.if", [true, "y", "n"])).toBe("y");
    expect(call("logic.if", [false, "y", "n"])).toBe("n");
    expect(call("logic.if", [null, "y", "n"])).toBe("n");
  });
});

describe("number", () => {
  test("arithmetic and its non-finite guard", () => {
    expect(call("number.add", [2, 3])).toBe(5);
    expect(call("number.subtract", [2, 3])).toBe(-1);
    expect(call("number.multiply", [2, 3])).toBe(6);
    expect(call("number.add", [1e308, 1e308])).toBe(null);
    expect(call("number.multiply", [1e308, 10])).toBe(null);
    expect(call("number.subtract", [-1e308, 1e308])).toBe(null);
  });

  test("division by zero is absence, including negative zero", () => {
    expect(call("number.divide", [7, 2])).toBe(3.5);
    expect(call("number.divide", [1, 0])).toBe(null);
    expect(call("number.divide", [1, -0])).toBe(null);
    expect(call("number.divide", [0, 0])).toBe(null);
    expect(call("number.divide", [0, 5])).toBe(0);
  });

  test("abs, negate, min and max", () => {
    expect(call("number.abs", [-3.5])).toBe(3.5);
    expect(call("number.abs", [3.5])).toBe(3.5);
    expect(call("number.negate", [0])).toBe(-0);
    expect(call("number.min", [3, 8])).toBe(3);
    expect(call("number.max", [3, 8])).toBe(8);
    expect(call("number.min", [-1, -1])).toBe(-1);
  });

  test("rounding is symmetric about zero", () => {
    expect(call("number.round", [2.5])).toBe(3);
    expect(call("number.round", [-2.5])).toBe(-3);
    expect(call("number.round", [2.4])).toBe(2);
    expect(call("number.round", [-2.4])).toBe(-2);
    expect(call("number.floor", [-1.2])).toBe(-2);
    expect(call("number.ceil", [-1.2])).toBe(-1);
    expect(call("number.floor", [3])).toBe(3);
  });

  test("comparisons", () => {
    expect(call("number.gt", [3, 2])).toBe(true);
    expect(call("number.gt", [2, 2])).toBe(false);
    expect(call("number.gte", [2, 2])).toBe(true);
    expect(call("number.lt", [2, 3])).toBe(true);
    expect(call("number.lte", [3, 2])).toBe(false);
    expect(call("number.gt", [null, 2])).toBe(null);
  });

  test("text rendering is canonical", () => {
    expect(call("number.toText", [3.5])).toBe("3.5");
    expect(call("number.toText", [-0])).toBe("0");
    expect(call("number.toText", [1000000])).toBe("1000000");
  });

  test("parsing accepts only strict JSON number text", () => {
    expect(call("number.parse", ["0"])).toBe(0);
    expect(call("number.parse", ["-12.5e2"])).toBe(-1250);
    expect(call("number.parse", ["1e3"])).toBe(1000);
    expect(call("number.parse", [""])).toBe(null);
    expect(call("number.parse", [" 1"])).toBe(null);
    expect(call("number.parse", ["1 "])).toBe(null);
    expect(call("number.parse", ["+1"])).toBe(null);
    expect(call("number.parse", ["01"])).toBe(null);
    expect(call("number.parse", ["1."])).toBe(null);
    expect(call("number.parse", [".5"])).toBe(null);
    expect(call("number.parse", ["0x10"])).toBe(null);
    expect(call("number.parse", ["Infinity"])).toBe(null);
    expect(call("number.parse", ["NaN"])).toBe(null);
    expect(call("number.parse", ["1e999"])).toBe(null);
  });
});

describe("text", () => {
  test("case folding is ASCII only and empty text survives", () => {
    expect(call("text.lower", ["Refund"])).toBe("refund");
    expect(call("text.upper", ["refund"])).toBe("REFUND");
    expect(call("text.lower", ["ÄÖÜ"])).toBe("ÄÖÜ");
    expect(call("text.upper", ["straße"])).toBe("STRAßE");
    expect(call("text.lower", [""])).toBe("");
    expect(call("text.upper", [""])).toBe("");
  });

  test("trim removes only pinned surrounding whitespace", () => {
    expect(call("text.trim", ["  a b \t\n"])).toBe("a b");
    expect(call("text.trim", ["   "])).toBe("");
    expect(call("text.trim", [""])).toBe("");
    expect(call("text.trim", ["　hi "])).toBe("hi");
  });

  test("length counts code points", () => {
    expect(call("text.length", [""])).toBe(0);
    expect(call("text.length", ["abc"])).toBe(3);
    expect(call("text.length", ["\u{1F600}\u{1F600}"])).toBe(2);
  });

  test("concat", () => {
    expect(call("text.concat", ["", ""])).toBe("");
    expect(call("text.concat", ["re", "fund"])).toBe("refund");
  });

  test("literal search predicates treat empty needles as always matching", () => {
    expect(call("text.contains", ["refund", "fun"])).toBe(true);
    expect(call("text.contains", ["refund", "FUN"])).toBe(false);
    expect(call("text.contains", ["refund", ""])).toBe(true);
    expect(call("text.contains", ["", ""])).toBe(true);
    expect(call("text.contains", ["", "a"])).toBe(false);
    expect(call("text.startsWith", ["refund", ""])).toBe(true);
    expect(call("text.startsWith", ["refund", "re"])).toBe(true);
    expect(call("text.startsWith", ["refund", "fund"])).toBe(false);
    expect(call("text.endsWith", ["refund", ""])).toBe(true);
    expect(call("text.endsWith", ["refund", "und"])).toBe(true);
  });

  test("a search needle is literal text, never a pattern", () => {
    expect(call("text.contains", ["refund", ".*"])).toBe(false);
    expect(call("text.contains", ["a.*b", ".*"])).toBe(true);
    expect(call("text.startsWith", ["abc", "^a"])).toBe(false);
  });

  test("case-insensitive exact match", () => {
    expect(call("text.equalsIgnoreCase", ["Refund", "REFUND"])).toBe(true);
    expect(call("text.equalsIgnoreCase", ["", ""])).toBe(true);
    expect(call("text.equalsIgnoreCase", ["a", "b"])).toBe(false);
  });

  test("compare is a stable code-unit ordering", () => {
    expect(call("text.compare", ["a", "b"])).toBe(-1);
    expect(call("text.compare", ["b", "a"])).toBe(1);
    expect(call("text.compare", ["a", "a"])).toBe(0);
    expect(call("text.compare", ["", "a"])).toBe(-1);
    expect(call("text.compare", ["A", "a"])).toBe(-1);
  });

  test("slice clamps and never wraps around", () => {
    expect(call("text.slice", ["refund", 0, 2])).toBe("re");
    expect(call("text.slice", ["refund", 2, 6])).toBe("fund");
    expect(call("text.slice", ["refund", -10, 99])).toBe("refund");
    expect(call("text.slice", ["refund", 4, 2])).toBe("");
    expect(call("text.slice", ["refund", 3, 3])).toBe("");
    expect(call("text.slice", ["", 0, 5])).toBe("");
    expect(call("text.slice", ["refund", 1.9, 3.9])).toBe("ef");
  });

  test("slice cuts on code points, not surrogate halves", () => {
    expect(call("text.slice", ["\u{1F600}x", 0, 1])).toBe("\u{1F600}");
    expect(call("text.slice", ["\u{1F600}x", 1, 2])).toBe("x");
  });

  test("indexOf is a code-point index", () => {
    expect(call("text.indexOf", ["refund", "fund"])).toBe(2);
    expect(call("text.indexOf", ["refund", "zz"])).toBe(-1);
    expect(call("text.indexOf", ["refund", ""])).toBe(0);
    expect(call("text.indexOf", ["", ""])).toBe(0);
    expect(call("text.indexOf", ["\u{1F600}ab", "ab"])).toBe(1);
  });

  test("replace is literal in both the search and the replacement", () => {
    expect(call("text.replace", ["a-b-c", "-", "+"])).toBe("a+b+c");
    expect(call("text.replace", ["aaa", "aa", "b"])).toBe("ba");
    expect(call("text.replace", ["abc", "", "!"])).toBe("abc");
    expect(call("text.replace", ["abc", "z", "!"])).toBe("abc");
    expect(call("text.replace", ["abc", "b", ""])).toBe("ac");
    expect(call("text.replace", ["ab", "a", "$&"])).toBe("$&b");
    expect(call("text.replace", ["ab", "a", "$'"])).toBe("$'b");
  });

  test("split returns one collection value and never fans out", () => {
    expect(call("text.split", ["a,b,c", ","])).toEqual(["a", "b", "c"]);
    expect(call("text.split", ["", ","])).toEqual([""]);
    expect(call("text.split", ["abc", ""])).toEqual(["abc"]);
    expect(call("text.split", ["a,,b", ","])).toEqual(["a", "", "b"]);
  });

  test("join requires well-formed text elements", () => {
    expect(call("text.join", [["a", "b"], "-"])).toBe("a-b");
    expect(call("text.join", [[], "-"])).toBe("");
    expect(call("text.join", [["a"], "-"])).toBe("a");
    expect(call("text.join", [["a", 1], "-"])).toBe(null);
    expect(call("text.join", [["a", null], "-"])).toBe(null);
    expect(call("text.join", [["a", "b"], ""])).toBe("ab");
  });

  test("absence propagates through every text function", () => {
    expect(call("text.lower", [null])).toBe(null);
    expect(call("text.length", [null])).toBe(null);
    expect(call("text.contains", [null, "a"])).toBe(null);
    expect(call("text.contains", ["a", null])).toBe(null);
    expect(call("text.split", [null, ","])).toBe(null);
    expect(call("text.join", [null, "-"])).toBe(null);
  });
});

describe("collection", () => {
  test("size and emptiness", () => {
    expect(call("collection.size", [[]])).toBe(0);
    expect(call("collection.size", [[1, 2, 3]])).toBe(3);
    expect(call("collection.isEmpty", [[]])).toBe(true);
    expect(call("collection.isEmpty", [[null]])).toBe(false);
  });

  test("membership is structural and can look for absence", () => {
    expect(call("collection.contains", [["a", "b"], "b"])).toBe(true);
    expect(call("collection.contains", [["a"], "b"])).toBe(false);
    expect(call("collection.contains", [[], "b"])).toBe(false);
    expect(call("collection.contains", [[{ a: 1 }], { a: 1 }])).toBe(true);
    expect(call("collection.contains", [[null], null])).toBe(true);
    expect(call("collection.contains", [["a"], null])).toBe(false);
    expect(call("collection.contains", [null, "b"])).toBe(null);
  });

  test("first, last and at over empty and out-of-range inputs", () => {
    expect(call("collection.first", [["a", "b"]])).toBe("a");
    expect(call("collection.last", [["a", "b"]])).toBe("b");
    expect(call("collection.first", [[]])).toBe(null);
    expect(call("collection.last", [[]])).toBe(null);
    expect(call("collection.at", [["a", "b"], 0])).toBe("a");
    expect(call("collection.at", [["a", "b"], 2])).toBe(null);
    expect(call("collection.at", [["a", "b"], -1])).toBe(null);
    expect(call("collection.at", [["a", "b"], 0.5])).toBe(null);
    expect(call("collection.at", [[], 0])).toBe(null);
  });

  test("distinct keeps first-occurrence order and compares structurally", () => {
    expect(call("collection.distinct", [[]])).toEqual([]);
    expect(call("collection.distinct", [["b", "a", "b", "a"]])).toEqual(["b", "a"]);
    expect(call("collection.distinct", [[{ a: 1 }, { a: 1 }]])).toEqual([{ a: 1 }]);
    expect(call("collection.distinct", [[1, "1", true]])).toEqual([1, "1", true]);
    expect(call("collection.distinct", [[null, null]])).toEqual([null]);
    expect(call("collection.distinct", [[0, -0]])).toEqual([0]);
  });

  test("slice clamps like text slice", () => {
    expect(call("collection.slice", [["a", "b", "c"], 1, 3])).toEqual(["b", "c"]);
    expect(call("collection.slice", [["a", "b", "c"], -4, 99])).toEqual(["a", "b", "c"]);
    expect(call("collection.slice", [["a", "b", "c"], 2, 1])).toEqual([]);
    expect(call("collection.slice", [[], 0, 5])).toEqual([]);
  });

  test("concat joins two collections into one value", () => {
    expect(call("collection.concat", [["a"], ["b"]])).toEqual(["a", "b"]);
    expect(call("collection.concat", [[], []])).toEqual([]);
    expect(call("collection.concat", [[["a"]], [["b"]]])).toEqual([["a"], ["b"]]);
  });

  test("concat does not mutate its inputs", () => {
    const left: StdlibValue = ["a"];
    const right: StdlibValue = ["b"];
    call("collection.concat", [left, right]);
    expect(left).toEqual(["a"]);
    expect(right).toEqual(["b"]);
  });

  test("absence propagates", () => {
    expect(call("collection.size", [null])).toBe(null);
    expect(call("collection.first", [null])).toBe(null);
    expect(call("collection.at", [["a"], null])).toBe(null);
    expect(call("collection.concat", [null, ["b"]])).toBe(null);
  });
});

describe("time", () => {
  test("comparison is strict and needs both instants", () => {
    expect(call("time.before", [1000, 2000])).toBe(true);
    expect(call("time.before", [2000, 2000])).toBe(false);
    expect(call("time.after", [2000, 1000])).toBe(true);
    expect(call("time.after", [2000, 2000])).toBe(false);
    expect(call("time.before", [null, 2000])).toBe(null);
    expect(call("time.after", [2000, null])).toBe(null);
  });

  test("arithmetic stays inside the representable instant range", () => {
    expect(call("time.addMillis", [1000, -250])).toBe(750);
    expect(call("time.addMillis", [1000, 0])).toBe(1000);
    expect(call("time.addMillis", [0, 0.5])).toBe(null);
    expect(call("time.addMillis", [MAX_TIMESTAMP_MILLIS, 1])).toBe(null);
    expect(call("time.addMillis", [-MAX_TIMESTAMP_MILLIS, -1])).toBe(null);
    expect(call("time.addMillis", [0, MAX_TIMESTAMP_MILLIS])).toBe(MAX_TIMESTAMP_MILLIS);
  });

  test("a shift too large to be exact is absent, not rounded", () => {
    expect(call("time.addMillis", [MAX_TIMESTAMP_MILLIS, Number.MAX_SAFE_INTEGER])).toBe(
      null,
    );
    expect(
      call("time.addMillis", [-MAX_TIMESTAMP_MILLIS, -Number.MAX_SAFE_INTEGER]),
    ).toBe(null);
  });

  test("difference is signed", () => {
    expect(call("time.diffMillis", [1000, 2500])).toBe(1500);
    expect(call("time.diffMillis", [2500, 1000])).toBe(-1500);
    expect(call("time.diffMillis", [1000, 1000])).toBe(0);
    expect(call("time.diffMillis", [null, 1000])).toBe(null);
  });

  test("a difference too large to be exact is absent, not rounded", () => {

    const from = -MAX_TIMESTAMP_MILLIS;
    const to = MAX_TIMESTAMP_MILLIS - 1;
    expect(to - from).toBe(17_280_000_000_000_000);
    expect(Number.isSafeInteger(to - from)).toBe(false);
    expect(call("time.diffMillis", [from, to])).toBe(null);
    expect(call("time.diffMillis", [to, from])).toBe(null);
  });

  test("a difference at the edge of exactness is still returned", () => {
    expect(call("time.diffMillis", [0, MAX_TIMESTAMP_MILLIS])).toBe(
      MAX_TIMESTAMP_MILLIS,
    );
    expect(call("time.diffMillis", [-1, MAX_TIMESTAMP_MILLIS])).toBe(
      MAX_TIMESTAMP_MILLIS + 1,
    );
  });
});

describe("the text domain is well-formed Unicode", () => {
  test("an unpaired surrogate is rejected wherever text is accepted", () => {
    expect(failureCode("text.length", ["\uD800"])).toBe("query_function_argument_type");
    expect(failureCode("text.indexOf", ["\uD800", "a"])).toBe(
      "query_function_argument_type",
    );
    expect(failureCode("text.indexOf", ["a", "\uDE00"])).toBe(
      "query_function_argument_type",
    );
    expect(failureCode("text.slice", ["\uD83D", 0, 1])).toBe(
      "query_function_argument_type",
    );
    expect(failureCode("text.contains", ["a", "\uDC00"])).toBe(
      "query_function_argument_type",
    );
  });

  test("an `any` parameter rejects it too, so the whole domain is well-formed", () => {
    expect(failureCode("logic.eq", ["\uD800", "a"])).toBe(
      "query_function_argument_type",
    );
    expect(failureCode("logic.isNull", ["\uD800"])).toBe(
      "query_function_argument_type",
    );
    expect(failureCode("collection.contains", [["a"], "\uD800"])).toBe(
      "query_function_argument_type",
    );
  });

  test("ill-formed text nested inside a collection is rejected too", () => {

    expect(failureCode("collection.first", [["\uD800"]])).toBe(
      "query_function_argument_domain",
    );
    expect(failureCode("collection.last", [["a", "\uD800"]])).toBe(
      "query_function_argument_domain",
    );
    expect(failureCode("text.join", [["a", "\uD800"], "-"])).toBe(
      "query_function_argument_domain",
    );
    expect(failureCode("logic.eq", [{ a: ["\uD800"] }, 1])).toBe(
      "query_function_argument_domain",
    );
    expect(call("collection.first", [["😀"]])).toBe("😀");
  });

  test("code-point indices stay consistent for astral text", () => {

    expect(call("text.indexOf", ["😀x", "x"])).toBe(1);
    expect(call("text.slice", ["😀x", 1, 2])).toBe("x");
    expect(call("text.length", ["😀x"])).toBe(2);
  });
});

describe("the value domain bounds nesting depth", () => {
  test("depth counts containers, with a scalar at zero", () => {
    expect(domainViolation(1)).toBeUndefined();
    expect(domainViolation(nest(1))).toBeUndefined();
    expect(domainViolation(nest(MAX_VALUE_DEPTH))).toBeUndefined();
    expect(domainViolation(nest(MAX_VALUE_DEPTH + 1))).toBe("tooDeep");
    expect(domainViolation({ a: { b: 1 } })).toBeUndefined();
  });

  test("objects and arrays count the same way", () => {
    let deep: StdlibValue = 1;
    for (let i = 0; i < MAX_VALUE_DEPTH; i += 1) deep = { a: deep };
    expect(domainViolation(deep)).toBeUndefined();
    expect(domainViolation({ a: deep })).toBe("tooDeep");
  });

  test("a call at the limit succeeds and one past it is refused", () => {
    const atLimit = nest(MAX_VALUE_DEPTH);
    expect(call("logic.eq", [atLimit, atLimit])).toBe(true);
    expect(call("collection.size", [atLimit])).toBe(1);

    const pastLimit = nest(MAX_VALUE_DEPTH + 1);
    expect(failureCode("logic.eq", [pastLimit, 1])).toBe(
      "query_function_argument_domain",
    );
    expect(failureCode("collection.size", [pastLimit])).toBe(
      "query_function_argument_domain",
    );
    expect(failureCode("collection.contains", [[1], pastLimit])).toBe(
      "query_function_argument_domain",
    );
    expect(failureCode("collection.distinct", [[pastLimit]])).toBe(
      "query_function_argument_domain",
    );
  });

  test("a 200,000-deep value is refused rather than crashing the isolate", () => {

    const veryDeep = nest(200_000);
    const outcome = evaluateQueryCall({
      name: "logic.eq",
      context: "let",
      args: [veryDeep, 1],
    });
    expect(Result.isFailure(outcome)).toBe(true);
    if (Result.isFailure(outcome)) {
      expect(sealStdlibFailure(outcome.failure)).toEqual({
        code: "query_function_argument_domain",
        function: "logic.eq",
        index: 0,
        parameter: "left",
        violation: "tooDeep",
      });
    }
  });

  test("the traversals themselves do not depend on the host call stack", () => {

    const a = nest(200_000);
    const b = nest(200_000);
    expect(() => deepEquals(a, b)).not.toThrow();
    expect(deepEquals(a, b)).toBe(true);
    expect(deepEquals(a, nest(199_999))).toBe(false);
    expect(() => canonicalKey(a)).not.toThrow();
    expect(canonicalKey(a)).toBe(canonicalKey(b));
    expect(() => domainViolation(a)).not.toThrow();
  });

  test("canonical keys stay injective under the iterative encoding", () => {
    expect(canonicalKey([1, [2]])).not.toBe(canonicalKey([[1], 2]));
    expect(canonicalKey([[]])).not.toBe(canonicalKey([]));
    expect(canonicalKey({ a: 1 })).not.toBe(canonicalKey([{ a: 1 }]));
    expect(canonicalKey({ ab: 1 })).not.toBe(canonicalKey({ a: "b1" }));
    expect(canonicalKey([1, 2])).not.toBe(canonicalKey([12]));
    expect(canonicalKey(1e5)).not.toBe(canonicalKey("1e5"));
    expect(canonicalKey({ a: 1, b: 2 })).toBe(canonicalKey({ b: 2, a: 1 }));
  });

  test("distinct deduplicates object elements regardless of key order", () => {
    expect(
      call("collection.distinct", [[{ a: 1, b: 2 }, { b: 2, a: 1 }, { a: 2 }]]),
    ).toEqual([{ a: 1, b: 2 }, { a: 2 }]);
  });
});

describe("produced text is bounded before it is allocated", () => {

  const failure = (name: string, args: readonly StdlibValue[]) => {
    const outcome = evaluateQueryCall({ name, context: "let", args });
    if (Result.isSuccess(outcome)) {
      throw new Error(`expected a failure for ${name}`);
    }
    return sealStdlibFailure(outcome.failure);
  };

  test("replace cannot multiply two small inputs into a huge one", () => {
    const value = "a".repeat(2_000);
    const replacement = "b".repeat(1_000);

    expect(failure("text.replace", [value, "a", replacement])).toEqual({
      code: "query_function_output_size",
      function: "text.replace",
      limit: MAX_PRODUCED_TEXT_UNITS,
    });
  });

  test("replace still runs when the result fits", () => {
    const value = "a".repeat(1_000);
    const produced = call("text.replace", [value, "a", "bb"]);
    expect(typeof produced).toBe("string");
    expect((produced as string).length).toBe(2_000);
  });

  test("replace that shrinks its input is never refused", () => {
    const value = "ab".repeat(500_000);
    expect(call("text.replace", [value, "ab", "a"])).toBe("a".repeat(500_000));
  });

  test("join cannot multiply item count by separator length", () => {
    const items = Array.from({ length: 2_000 }, () => "x");
    const separator = "y".repeat(1_000);
    expect(failure("text.join", [items, separator])).toEqual({
      code: "query_function_output_size",
      function: "text.join",
      limit: MAX_PRODUCED_TEXT_UNITS,
    });
  });

  test("join still runs when the result fits", () => {
    const items = Array.from({ length: 1_000 }, () => "x");
    expect(call("text.join", [items, "-"])).toBe(
      Array.from({ length: 1_000 }, () => "x").join("-"),
    );
  });

  test("concat is bounded by the same cap", () => {
    const half = "a".repeat(MAX_PRODUCED_TEXT_UNITS / 2);
    expect(typeof call("text.concat", [half, half])).toBe("string");
    expect(failure("text.concat", [half, `${half}!`])).toEqual({
      code: "query_function_output_size",
      function: "text.concat",
      limit: MAX_PRODUCED_TEXT_UNITS,
    });
  });

  test("the refusal names the limit and nothing about the input", () => {
    const secret = "hidden-value-0xfeedface";
    const sealed = failure("text.replace", [
      secret.repeat(200),
      secret,
      "z".repeat(20_000),
    ]);
    expect(JSON.stringify(sealed)).not.toContain(secret);
    expect(Object.keys(sealed).sort()).toEqual(["code", "function", "limit"]);
  });
});

describe("determinism", () => {
  test("every published example is stable across repeated evaluation", () => {
    for (const card of standardLibraryV1.functions) {
      for (const example of card.examples) {
        const first = call(card.name, example.args, card.contexts[0]);
        const second = call(card.name, example.args, card.contexts[0]);
        const third = call(card.name, example.args, card.contexts[0]);
        expect(first).toEqual(second);
        expect(second).toEqual(third);
      }
    }
  });

  test("the same call in different admitted contexts gives the same value", () => {
    for (const card of standardLibraryV1.functions) {
      const example = card.examples[0];
      const values = card.contexts.map((context) =>
        call(card.name, example.args, context),
      );
      for (const value of values) {
        expect(value).toEqual(values[0]);
      }
    }
  });
});
