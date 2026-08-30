/**
 * Manifest integrity for the v1 expression standard library (#507).
 *
 * The manifest is the single source of truth, so these tests are the proof
 * that it actually is one: every entry has an implementation and vice versa,
 * every published example really evaluates to the result it publishes, names
 * are stable and namespaced, and the whole manifest projects to JSON so a
 * capability card can be derived mechanically rather than hand-written.
 */

import { describe, expect, test } from "bun:test";
import * as Result from "effect/Result";
import {
  EXPRESSION_CONTEXTS,
  QUERY_STDLIB_VERSION,
  STDLIB_NAMESPACES,
  evaluateQueryCall,
  isQueryFunctionName,
  lookupQueryFunction,
  queryFunctionNames,
  standardLibraryV1,
  stdlibIntegrityProblems,
  type FunctionCard,
} from "../../../../src/db/query/stdlib/index.ts";

const cards: readonly FunctionCard[] = standardLibraryV1.functions;

/**
 * The published v1 inventory. This list is a contract: an entry may be added
 * below, but renaming or removing one is a query-language break, not a patch.
 */
const EXPECTED_NAMES: readonly string[] = [
  "collection.at",
  "collection.concat",
  "collection.contains",
  "collection.distinct",
  "collection.first",
  "collection.isEmpty",
  "collection.last",
  "collection.size",
  "collection.slice",
  "logic.and",
  "logic.coalesce",
  "logic.eq",
  "logic.if",
  "logic.isNull",
  "logic.ne",
  "logic.not",
  "logic.or",
  "number.abs",
  "number.add",
  "number.ceil",
  "number.divide",
  "number.floor",
  "number.gt",
  "number.gte",
  "number.lt",
  "number.lte",
  "number.max",
  "number.min",
  "number.multiply",
  "number.negate",
  "number.parse",
  "number.round",
  "number.subtract",
  "number.toText",
  "text.compare",
  "text.concat",
  "text.contains",
  "text.endsWith",
  "text.equalsIgnoreCase",
  "text.indexOf",
  "text.join",
  "text.length",
  "text.lower",
  "text.replace",
  "text.slice",
  "text.split",
  "text.startsWith",
  "text.trim",
  "text.upper",
  "time.addMillis",
  "time.after",
  "time.before",
  "time.diffMillis",
];

describe("standard library manifest", () => {
  test("manifest and implementations correspond exactly", () => {
    expect(stdlibIntegrityProblems()).toEqual([]);
  });

  test("the published inventory is the stable v1 name set", () => {
    expect(queryFunctionNames()).toEqual(EXPECTED_NAMES);
  });

  test("the manifest declares version 1", () => {
    expect(standardLibraryV1.version).toBe(QUERY_STDLIB_VERSION);
    expect(QUERY_STDLIB_VERSION).toBe(1);
  });

  test("every name is namespaced under a declared v1 namespace", () => {
    for (const card of cards) {
      expect(STDLIB_NAMESPACES).toContain(card.namespace);
      expect(card.name.startsWith(`${card.namespace}.`)).toBe(true);
      expect(card.name.split(".")).toHaveLength(2);
    }
  });

  test("every namespace is populated", () => {
    for (const namespace of STDLIB_NAMESPACES) {
      expect(cards.some((card) => card.namespace === namespace)).toBe(true);
    }
  });

  test("every v1 function is deterministic", () => {
    for (const card of cards) {
      expect(card.deterministic).toBe(true);
    }
  });

  test("no v1 function is superlinear", () => {
    for (const card of cards) {
      expect(["constant", "linear"]).toContain(card.cost);
    }
  });

  test("cardinality agrees with the declared result type", () => {
    for (const card of cards) {
      const expected = card.signature.result === "collection" ? "collection" : "one";
      expect(card.cardinality).toBe(expected);
    }
  });

  test("contexts are non-empty, unique, and drawn from the declared set", () => {
    for (const card of cards) {
      expect(card.contexts.length).toBeGreaterThan(0);
      expect(new Set(card.contexts).size).toBe(card.contexts.length);
      for (const context of card.contexts) {
        expect(EXPRESSION_CONTEXTS).toContain(context);
      }
    }
  });

  test("collection-valued calls are not admitted as sort keys", () => {
    for (const card of cards) {
      if (card.signature.result !== "collection") continue;
      expect(card.contexts).not.toContain("orderBy");
    }
  });

  test("parameter names are documented and unique per function", () => {
    for (const card of cards) {
      const names = card.signature.parameters.map((parameter) => parameter.name);
      expect(new Set(names).size).toBe(names.length);
      for (const parameter of card.signature.parameters) {
        expect(parameter.name.length).toBeGreaterThan(0);
        expect(parameter.doc.length).toBeGreaterThan(0);
      }
    }
  });

  test("every function documents itself in one line", () => {
    for (const card of cards) {
      expect(card.doc.length).toBeGreaterThan(0);
      expect(card.doc).not.toContain("\n");
    }
  });

  test("the manifest is plain JSON, so cards project mechanically", () => {
    const round = JSON.parse(JSON.stringify(standardLibraryV1)) as unknown;
    expect(round).toEqual(JSON.parse(JSON.stringify(standardLibraryV1)));
    expect(round).toEqual(standardLibraryV1 as unknown);
  });

  test("lookup resolves published names and nothing else", () => {
    for (const name of EXPECTED_NAMES) {
      expect(isQueryFunctionName(name)).toBe(true);
      expect(lookupQueryFunction(name)?.name).toBe(name);
    }
  });

  test("a card carries no implementation reference", () => {
    for (const card of cards) {
      for (const value of Object.values(card as unknown as Record<string, unknown>)) {
        expect(typeof value).not.toBe("function");
      }
    }
  });
});

describe("published examples are executable", () => {
  for (const card of cards) {
    test(`${card.name} examples evaluate as documented`, () => {
      expect(card.examples.length).toBeGreaterThan(0);
      for (const example of card.examples) {
        expect(example.args).toHaveLength(card.signature.parameters.length);
        const outcome = evaluateQueryCall({
          name: card.name,
          context: card.contexts[0],
          args: example.args,
        });
        expect(Result.isSuccess(outcome)).toBe(true);
        if (Result.isSuccess(outcome)) {
          expect(outcome.success).toEqual(example.result);
        }
      }
    });
  }
});

describe("nothing nondeterministic or ambient is reachable", () => {
  const forbidden: readonly (readonly [string, RegExp])[] = [
    ["a clock", /\bDate\b/],
    ["randomness", /Math\s*\.\s*random/],
    ["crypto", /\bcrypto\b/],
    ["the process environment", /\bprocess\s*\./],
    ["the global object", /\bglobalThis\b/],
    ["the network", /\bfetch\s*\(/],
    ["dynamic evaluation", /\beval\s*\(|new\s+Function\b/],
    ["a caller-constructed regex", /new\s+RegExp\b/],
    ["module lookup", /\brequire\s*\(|\bimport\s*\(/],
  ];

  for (const file of ["implementations.ts", "manifest.ts", "values.ts"] as const) {
    test(`${file} reaches for none of it`, async () => {
      const source = await Bun.file(
        new URL(`../../../../src/db/query/stdlib/${file}`, import.meta.url).pathname,
      ).text();
      for (const [label, pattern] of forbidden) {
        expect({ file, label, found: pattern.test(source) }).toEqual({
          file,
          label,
          found: false,
        });
      }
    });
  }
});
