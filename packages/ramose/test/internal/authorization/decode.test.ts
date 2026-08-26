import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { sha256Hex } from "../../../src/internal/core/bytes.ts";
import {
  AUTHORIZATION_CANONICAL_JSON_VERSION,
  INSTALLED_AUTHORIZATION_IR_VERSION,
  InvalidIR,
  MAX_COLLECTION_SIZE,
  MAX_JSON_DEPTH,
  MAX_JSON_ENCODED_BYTES,
  MAX_JSON_NODES,
  MAX_STRING_LENGTH,
  POLICY_TEMPLATE_IR_VERSION,
  canonicalizeInstalledAuthorization,
  canonicalizeJson,
  canonicalizePolicyTemplate,
  compareCanonicalKeys,
  decodeInstalledAuthorization,
  decodeInstalledAuthorizationResult,
  decodePolicyTemplate,
  decodePolicyTemplateResult,
  encodeInstalledAuthorization,
  encodePolicyTemplate,
  hashCanonicalJson,
  hashCanonicalRule,
  hashInstalledAuthorization,
  hashPolicyTemplate,
  hashRelativeRule,
  type InstalledAuthorizationIR,
  type JsonValue,
  type PolicyTemplateIR,
} from "../../../src/internal/authorization/index.ts";
import {
  POLICY_HASH_OTHER,
  POLICY_HASH_PLACEHOLDER,
  RULE_DEPTH,
  RULE_LIT,
  RULE_OWNS_ISSUE,
  RULE_SAME,
  emptyTemplateEncoded,
  installedEncoded,
  templateEncoded,
} from "./fixtures.ts";

const hashOf = <A>(effect: Effect.Effect<A, InvalidIR>) => Effect.runPromise(effect);

/** JSON-tree clone. Parsed JSON has no shared object identity. */
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const expectInvalid = (result: Result.Result<unknown, InvalidIR>, pattern: RegExp) => {
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) {
    expect(result.failure).toBeInstanceOf(InvalidIR);
    expect(result.failure._tag).toBe("InvalidIR");
    expect(result.failure.message).toMatch(pattern);
  }
};

/** Rows of `leaf` totaling `leaves` values. Node count is 1 + rows + leaves. */
const leafRows = (leaf: unknown, leaves: number): unknown[] => {
  const rows: unknown[] = [];
  let left = leaves;
  while (left > 0) {
    const n = Math.min(MAX_COLLECTION_SIZE, left);
    rows.push(Array.from({ length: n }, () => leaf));
    left -= n;
  }
  return rows;
};

/** Array of objects whose keys are `leaf`. Node count is 1 + objects + 2 * objects * keys. */
const leafObjects = (leaf: unknown, objects: number, keys: number): unknown[] =>
  Array.from({ length: objects }, (_, i) =>
    Object.fromEntries(Array.from({ length: keys }, (_, j) => [`k${i}_${j}`, leaf])),
  );

const expectPlainFrozen = (value: object) => {
  expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
  expect(Object.isFrozen(value)).toBe(true);
  expect(Object.prototype.hasOwnProperty.call(value, "constructor")).toBe(false);
};

describe("structural decoding", () => {
  test("decodes a hand-written template into plain frozen data", () => {
    const result = decodePolicyTemplateResult(clone(templateEncoded));
    expect(Result.isSuccess(result)).toBe(true);
    if (!Result.isSuccess(result)) return;
    const decoded = result.success;
    expect(decoded._tag).toBe("PolicyTemplateIR");
    expect(decoded.version).toBe(POLICY_TEMPLATE_IR_VERSION);
    expectPlainFrozen(decoded);
    expect(Object.isFrozen(decoded.rules)).toBe(true);
    expect(Object.isFrozen(decoded.rules[0])).toBe(true);
    expect(() => {
      (decoded as unknown as { classes: string[] }).classes.push("admin");
    }).toThrow();
  });

  test("decodes a hand-written installed document into plain frozen data", () => {
    const result = decodeInstalledAuthorizationResult(clone(installedEncoded));
    expect(Result.isSuccess(result)).toBe(true);
    if (!Result.isSuccess(result)) return;
    expect(result.success._tag).toBe("InstalledAuthorizationIR");
    expect(result.success.version).toBe(INSTALLED_AUTHORIZATION_IR_VERSION);
    expect(String(result.success.catalog)).toBe("app");
    expectPlainFrozen(result.success);
  });

  test("Effect wrappers convert failures at the outer boundary", () => {
    const ok = Effect.runSync(decodePolicyTemplate(clone(emptyTemplateEncoded)));
    expect(ok._tag).toBe("PolicyTemplateIR");
    expect(() => Effect.runSync(decodePolicyTemplate({ nope: true }))).toThrow(InvalidIR);
    expect(() =>
      Effect.runSync(decodeInstalledAuthorization(clone(templateEncoded))),
    ).toThrow(InvalidIR);
  });

  test("a structurally valid template is not installed IR", () => {
    const template = Effect.runSync(decodePolicyTemplate(clone(templateEncoded)));
    const installed = decodeInstalledAuthorizationResult(clone(templateEncoded));
    expectInvalid(installed, /InstalledAuthorizationIR|_tag|Expected/);
    expect(template._tag).not.toBe("InstalledAuthorizationIR");
  });
});

describe("JSON-only rejections", () => {
  test.each([
    ["function", { ...emptyTemplateEncoded, extra: () => 1 }, /function|JSON/],
    ["symbol value", { ...emptyTemplateEncoded, extra: Symbol("x") }, /symbol|JSON/],
    ["bigint", { ...emptyTemplateEncoded, extra: 1n }, /bigint|JSON/],
    ["NaN", { ...emptyTemplateEncoded, extra: Number.NaN }, /NaN|JSON/],
    ["Infinity", { ...emptyTemplateEncoded, extra: Number.POSITIVE_INFINITY }, /Infinity|JSON/],
    ["-Infinity", { ...emptyTemplateEncoded, extra: Number.NEGATIVE_INFINITY }, /Infinity|JSON/],
    ["undefined", { ...emptyTemplateEncoded, extra: undefined }, /undefined|JSON/],
    ["Date", { ...emptyTemplateEncoded, extra: new Date(0) }, /prototype|JSON/],
    ["Map", { ...emptyTemplateEncoded, extra: new Map() }, /prototype|JSON/],
    ["Set", { ...emptyTemplateEncoded, extra: new Set() }, /prototype|JSON/],
    ["Uint8Array", { ...emptyTemplateEncoded, extra: new Uint8Array() }, /prototype|JSON/],
    ["class instance", { ...emptyTemplateEncoded, extra: new (class Box {})() }, /prototype|JSON/],
  ] as const)("rejects %s", (_name, input, pattern) => {
    expectInvalid(decodePolicyTemplateResult(input), pattern);
  });

  test("rejects a function at the root", () => {
    expectInvalid(decodePolicyTemplateResult(() => "policy"), /function|JSON/);
  });

  test("rejects a symbol at the root", () => {
    expectInvalid(decodePolicyTemplateResult(Symbol("policy")), /symbol|JSON/);
  });

  test("rejects bigint at the root", () => {
    expectInvalid(decodePolicyTemplateResult(1n), /bigint|JSON/);
  });

  test("rejects NaN at the root", () => {
    expectInvalid(decodePolicyTemplateResult(Number.NaN), /NaN|JSON/);
  });

  test("rejects Infinity at the root", () => {
    expectInvalid(decodePolicyTemplateResult(Number.POSITIVE_INFINITY), /Infinity|JSON/);
  });

  test("rejects undefined at the root", () => {
    expectInvalid(decodePolicyTemplateResult(undefined), /undefined|JSON/);
  });

  test("rejects a cycle", () => {
    const cycle: Record<string, unknown> = { ...emptyTemplateEncoded };
    cycle.self = cycle;
    expectInvalid(decodePolicyTemplateResult(cycle), /cycle|JSON/);
  });

  test("rejects a symbol key", () => {
    const input = { ...emptyTemplateEncoded, [Symbol("hidden")]: true };
    expectInvalid(decodePolicyTemplateResult(input), /symbol|JSON/);
  });

  test("rejects an accessor property without invoking it", () => {
    let reads = 0;
    const input = { ...emptyTemplateEncoded } as Record<string, unknown>;
    Object.defineProperty(input, "sneak", {
      enumerable: true,
      get: () => {
        reads += 1;
        return 1;
      },
    });
    expectInvalid(decodePolicyTemplateResult(input), /prototype|JSON|function/);
    expect(reads).toBe(0);
  });

  test("rejects extra own properties on an array", () => {
    const rules = [] as unknown as unknown[] & { extra: string };
    rules.extra = "nope";
    expectInvalid(decodePolicyTemplateResult({ ...emptyTemplateEncoded, rules }), /symbol|JSON|array/);
  });

  test("rejects a sparse array", () => {
    const exprs = ["ok"] as unknown[];
    exprs[2] = { _tag: "const", value: true };
    expectInvalid(
      decodePolicyTemplateResult({
        ...emptyTemplateEncoded,
        rules: [
          {
            id: RULE_LIT,
            focus: { _tag: "entity", entity: { _tag: "RelativeEntityId", name: "issue" } },
            expr: { _tag: "and", exprs },
            usesResource: false,
            usesInput: false,
            usesMe: false,
            usesSubject: false,
            traversalDepth: 0,
            existsDepth: 0,
            dependencies: [],
          },
        ],
      }),
      /undefined|JSON/,
    );
  });

  test("rejects an oversized string", () => {
    expectInvalid(
      decodePolicyTemplateResult({
        ...emptyTemplateEncoded,
        principal: { subjectClaim: "x".repeat(MAX_STRING_LENGTH + 1) },
      }),
      /oversized string/,
    );
  });

  test("rejects an oversized collection", () => {
    expectInvalid(
      decodePolicyTemplateResult({
        ...emptyTemplateEncoded,
        classes: Array.from({ length: MAX_COLLECTION_SIZE + 1 }, (_, i) => `c${i}`),
      }),
      /oversized collection/,
    );
  });

  test("rejects oversized depth as InvalidIR without throwing", () => {
    let nested: unknown = null;
    for (let i = 0; i < MAX_JSON_DEPTH + 2; i++) nested = { child: nested };
    const result = decodePolicyTemplateResult({ ...emptyTemplateEncoded, extra: nested });
    expectInvalid(result, /oversized depth/);
  });

  test("rejects a broad tree that stays inside depth and collection limits", () => {
    const bushy = (depth: number): unknown =>
      depth === 0 ? 0 : { l: bushy(depth - 1), r: bushy(depth - 1) };
    expect(MAX_JSON_NODES).toBeLessThan(2 ** 13);
    expectInvalid(
      decodePolicyTemplateResult({ ...emptyTemplateEncoded, extra: bushy(12) }),
      /oversized document/,
    );
  });

  test("rejects a document whose encoded strings exceed the byte budget", () => {
    const fields: Record<string, string> = {};
    const perString = MAX_STRING_LENGTH;
    const count = Math.floor(MAX_JSON_ENCODED_BYTES / perString) + 2;
    for (let i = 0; i < count; i++) fields[`k${i}`] = "x".repeat(perString);
    expectInvalid(
      decodePolicyTemplateResult({ ...emptyTemplateEncoded, extra: fields }),
      /oversized document/,
    );
  });

  test("rejects a small repeated object reference as an alias", () => {
    const shared = { a: 1 };
    expectInvalid(
      decodePolicyTemplateResult({ ...emptyTemplateEncoded, extra: { x: shared, y: shared } }),
      /alias/,
    );
  });

  test("rejects a repeated reference spliced below the depth ceiling before Schema walks it", () => {
    const chain = (n: number, leaf: unknown): unknown => {
      let value = leaf;
      for (let i = 0; i < n; i++) value = { n: value };
      return value;
    };
    const shared = { n: 1 };
    expectInvalid(
      decodePolicyTemplateResult({
        ...emptyTemplateEncoded,
        extra: { a: shared, b: chain(10, shared) },
      }),
      /alias/,
    );
  });

  test("accepts independently allocated but structurally equal subtrees", () => {
    expectInvalid(
      decodePolicyTemplateResult({
        ...emptyTemplateEncoded,
        extra: { x: { a: 1 }, y: { a: 1 } },
      }),
      /extra|unexpected|excess|Key/i,
    );
  });

  test.each([true, false, null] as const)(
    "charges a broad array of %s leaves at the exact node limit and one over",
    (leaf) => {
      // 4 inner arrays + 4091 leaves + 1 outer array = 4096 nodes.
      const exact = leafRows(leaf, 4091);
      expectInvalid(decodePolicyTemplateResult(exact), /PolicyTemplateIR|_tag|Expected|JSON/);
      const over = leafRows(leaf, 4092);
      expectInvalid(decodePolicyTemplateResult(over), /oversized document/);
    },
  );

  test.each([true, false, null] as const)(
    "charges a broad object of %s leaves at the exact node limit and one over",
    (leaf) => {
      // 1 outer array + 5 objects + 5×409 keys + 5×409 leaves = 4096 nodes.
      const exact = leafObjects(leaf, 5, 409);
      expectInvalid(decodePolicyTemplateResult(exact), /PolicyTemplateIR|_tag|Expected|JSON/);
      exact.push(leaf);
      expectInvalid(decodePolicyTemplateResult(exact), /oversized document/);
    },
  );

  test("rejects every prototype other than Object.prototype or null", () => {
    const nestedNull = Object.create(Object.create(null));
    nestedNull.x = 1;
    expectInvalid(
      decodePolicyTemplateResult({ ...emptyTemplateEncoded, extra: nestedNull }),
      /prototype/,
    );
  });

  test("rejects dense-array holes created by a high index", () => {
    const rules: unknown[] = [];
    rules[3] = "nope";
    expectInvalid(
      decodePolicyTemplateResult({ ...emptyTemplateEncoded, rules }),
      /undefined|array|JSON/,
    );
  });

  test("rejects a lone low surrogate before Schema walks the input", () => {
    expectInvalid(
      decodePolicyTemplateResult({
        ...emptyTemplateEncoded,
        principal: { subjectClaim: "\uDEAD" },
      }),
      /unicode/,
    );
  });

  test("rejects a trailing unpaired high surrogate", () => {
    expectInvalid(
      decodePolicyTemplateResult({
        ...emptyTemplateEncoded,
        principal: { subjectClaim: "abc\uD800" },
      }),
      /unicode/,
    );
    expectInvalid(
      decodePolicyTemplateResult({
        ...emptyTemplateEncoded,
        principal: { subjectClaim: "abc\uDBFF" },
      }),
      /unicode/,
    );
  });

  test("rejects a high surrogate followed by a non-low surrogate", () => {
    expectInvalid(
      decodePolicyTemplateResult({
        ...emptyTemplateEncoded,
        principal: { subjectClaim: "\uD800A" },
      }),
      /unicode/,
    );
    expectInvalid(
      decodePolicyTemplateResult({
        ...emptyTemplateEncoded,
        principal: { subjectClaim: "\uD800\uD800" },
      }),
      /unicode/,
    );
  });

  test("rejects a lone surrogate in an object key", () => {
    const extra: Record<string, unknown> = {};
    Object.defineProperty(extra, "abc\uD800", {
      value: 1,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    expectInvalid(decodePolicyTemplateResult({ ...emptyTemplateEncoded, extra }), /unicode/);
  });

  test("accepts a well-formed supplementary character", () => {
    const decoded = Effect.runSync(
      decodePolicyTemplate({
        ...emptyTemplateEncoded,
        principal: { subjectClaim: "abc\uD83D\uDE00" },
      }),
    );
    expect(decoded.principal.subjectClaim).toBe("abc\uD83D\uDE00");
  });
});

describe("schema shape rejections", () => {
  test("rejects unknown keys", () => {
    expectInvalid(
      decodePolicyTemplateResult({ ...emptyTemplateEncoded, extra: true }),
      /extra|unexpected|excess|Key/i,
    );
  });

  test("rejects a nested unknown key", () => {
    expectInvalid(
      decodePolicyTemplateResult({
        ...emptyTemplateEncoded,
        principal: { subjectClaim: "sub", unexpected: 1 },
      }),
      /unexpected|extra|excess|Key/i,
    );
  });

  test("rejects the wrong version discriminator", () => {
    expectInvalid(
      decodePolicyTemplateResult({ ...emptyTemplateEncoded, version: 2 }),
      /2|Literal|version/i,
    );
  });

  test("rejects a missing tag", () => {
    const { _tag: _, ...untagged } = emptyTemplateEncoded;
    expectInvalid(decodePolicyTemplateResult(untagged), /_tag|PolicyTemplateIR/);
  });

  test("rejects an ownerless operation identity", () => {
    expectInvalid(
      decodePolicyTemplateResult({
        ...emptyTemplateEncoded,
        decisions: {
          entities: [],
          traits: [],
          fields: [],
          operations: [
            {
              target: { _tag: "RelativeOperationId", localName: "create", target: "none" },
              decision: { allow: [], deny: [] },
            },
          ],
        },
      }),
      /owner|RelativeOperationId/i,
    );
  });

  test("rejects a non-finite literal", () => {
    expectInvalid(
      decodePolicyTemplateResult({
        ...emptyTemplateEncoded,
        rules: [
          {
            id: RULE_LIT,
            focus: { _tag: "entity", entity: { _tag: "RelativeEntityId", name: "issue" } },
            expr: { _tag: "eq", left: { _tag: "lit", value: Number.NaN }, right: { _tag: "lit", value: 1 } },
            usesResource: false,
            usesInput: false,
            usesMe: false,
            usesSubject: false,
            traversalDepth: 0,
            existsDepth: 0,
            dependencies: [],
          },
        ],
      }),
      /NaN|JSON|Finite/i,
    );
  });

  test("rejects a negative traversal depth", () => {
    expectInvalid(
      decodePolicyTemplateResult({
        ...emptyTemplateEncoded,
        rules: [
          {
            id: RULE_DEPTH,
            focus: { _tag: "entity", entity: { _tag: "RelativeEntityId", name: "issue" } },
            expr: { _tag: "const", value: true },
            usesResource: false,
            usesInput: false,
            usesMe: false,
            usesSubject: false,
            traversalDepth: -1,
            existsDepth: 0,
            dependencies: [],
          },
        ],
      }),
      /greater than or equal|Natural|Expected/i,
    );
  });

  test("rejects a template where installed IR is required", () => {
    expectInvalid(decodeInstalledAuthorizationResult(clone(templateEncoded)), /InstalledAuthorizationIR|_tag/);
  });

  test("rejects an installed document missing catalog identity", () => {
    const rest = clone(installedEncoded) as Record<string, unknown>;
    delete rest.catalog;
    expectInvalid(decodeInstalledAuthorizationResult(rest), /catalog/i);
  });

  test("rejects a non-digest rule id", () => {
    expectInvalid(
      decodePolicyTemplateResult({
        ...emptyTemplateEncoded,
        rules: [
          {
            id: "owns-issue",
            focus: { _tag: "entity", entity: { _tag: "RelativeEntityId", name: "issue" } },
            expr: { _tag: "const", value: true },
            usesResource: false,
            usesInput: false,
            usesMe: false,
            usesSubject: false,
            traversalDepth: 0,
            existsDepth: 0,
            dependencies: [],
          },
        ],
      }),
      /pattern|hex|Expected|RuleId/i,
    );
  });

  test("rejects a non-digest policy hash", () => {
    expectInvalid(
      decodeInstalledAuthorizationResult({ ...clone(installedEncoded), policyHash: "policy" }),
      /pattern|hex|Expected|PolicyHash/i,
    );
  });
});

describe("rule identity collisions", () => {
  test("fails closed when one rule id maps to different canonical bodies", () => {
    const colliding = {
      ...clone(emptyTemplateEncoded),
      rules: [
      {
        id: RULE_SAME,
        focus: { _tag: "entity", entity: { _tag: "RelativeEntityId", name: "issue" } },
        expr: { _tag: "const", value: true },
        usesResource: false,
        usesInput: false,
        usesMe: false,
        usesSubject: false,
        traversalDepth: 0,
        existsDepth: 0,
        dependencies: [],
      },
      {
        id: RULE_SAME,
        focus: { _tag: "entity", entity: { _tag: "RelativeEntityId", name: "issue" } },
        expr: { _tag: "const", value: false },
        usesResource: false,
        usesInput: false,
        usesMe: false,
        usesSubject: false,
        traversalDepth: 0,
        existsDepth: 0,
        dependencies: [],
      },
      ],
    };
    expectInvalid(decodePolicyTemplateResult(colliding), /rule identity collision/);
  });

  test("fails closed on a duplicate rule id with the same body", () => {
    const rule = {
      id: RULE_SAME,
      focus: { _tag: "entity", entity: { _tag: "RelativeEntityId", name: "issue" } },
      expr: { _tag: "const", value: true },
      usesResource: false,
      usesInput: false,
      usesMe: false,
      usesSubject: false,
      traversalDepth: 0,
      existsDepth: 0,
      dependencies: [],
    };
    expectInvalid(
      decodePolicyTemplateResult({ ...emptyTemplateEncoded, rules: [rule, clone(rule)] }),
      /duplicate rule identity/,
    );
  });

  test("fails closed on a duplicate decision target", () => {
    const target = { _tag: "RelativeEntityId", name: "issue" };
    expectInvalid(
      decodePolicyTemplateResult({
        ...emptyTemplateEncoded,
        decisions: {
          entities: [
            { target, decision: { allow: [], deny: [] } },
            { target: clone(target), decision: { allow: [RULE_SAME], deny: [] } },
          ],
          traits: [],
          fields: [],
          operations: [],
        },
      }),
      /duplicate entity decision target/,
    );
  });

  test("fails closed when an installed rule id maps to different bodies", () => {
    const base = clone(installedEncoded);
    const colliding = {
      ...base,
      rules: [
        base.rules[0],
        {
          ...clone(base.rules[0]),
          expr: { _tag: "const", value: false },
        },
      ],
    };
    expectInvalid(decodeInstalledAuthorizationResult(colliding), /rule identity collision/);
  });

  test("fails closed on a duplicate installed identity", () => {
    const base = clone(installedEncoded);
    expectInvalid(
      decodeInstalledAuthorizationResult({
        ...base,
        identities: {
          ...base.identities,
          entities: [base.identities.entities[0], clone(base.identities.entities[0])],
        },
      }),
      /duplicate entity identity/,
    );
  });

  test("fails closed when one access-plan id maps to different bodies", () => {
    const base = clone(installedEncoded);
    expectInvalid(
      decodeInstalledAuthorizationResult({
        ...base,
        accessPlans: [
          base.accessPlans[0],
          { rule: RULE_OWNS_ISSUE, lookups: [] },
        ],
      }),
      /access-plan identity collision/,
    );
  });

  test("fails closed on duplicate-identical operation descriptors", () => {
    const base = clone(installedEncoded);
    expectInvalid(
      decodeInstalledAuthorizationResult({
        ...base,
        operations: [base.operations[0], clone(base.operations[0])],
      }),
      /duplicate operation identity/,
    );
  });

  test("fails closed when one operation id maps to different input shapes", () => {
    const base = clone(installedEncoded);
    expectInvalid(
      decodeInstalledAuthorizationResult({
        ...base,
        operations: [
          base.operations[0],
          {
            ...clone(base.operations[0]),
            input: { _tag: "opaque" },
          },
        ],
      }),
      /operation identity collision/,
    );
  });
});

describe("canonical serialization", () => {
  const utf8 = new TextEncoder();

  test("Web Crypto SHA-256 empty-string vector", async () => {
    expect(await sha256Hex(utf8.encode(""))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  test("Web Crypto SHA-256 NIST and multi-block vectors", async () => {
    expect(await sha256Hex(utf8.encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(await sha256Hex(utf8.encode("hello"))).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
    expect(await sha256Hex(utf8.encode("a".repeat(1000)))).toBe(
      "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3",
    );
  });

  test("RFC 8785 goldens for special keys, integers, escapes, and numbers", () => {
    expect(AUTHORIZATION_CANONICAL_JSON_VERSION).toBe("rfc8785-jcs/1");
    expect(canonicalizeJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalizeJson({ 10: 1, 2: 2 })).toBe('{"10":1,"2":2}');
    const special = JSON.parse('{"__proto__":1,"constructor":2,"prototype":3}') as JsonValue;
    expect(canonicalizeJson(special)).toBe('{"__proto__":1,"constructor":2,"prototype":3}');
    expect(canonicalizeJson(JSON.parse('{"__proto__":{"x":1}}') as JsonValue)).not.toBe("{}");
    expect(canonicalizeJson('€$\u000f\nA\'B"\\"/')).toBe('"€$\\u000f\\nA\'B\\"\\\\\\"/"');
    expect(canonicalizeJson("\b\t\n\f\r")).toBe('"\\b\\t\\n\\f\\r"');
    expect(canonicalizeJson("\u0001")).toBe('"\\u0001"');
    expect(canonicalizeJson(-0)).toBe("0");
    expect(canonicalizeJson(0)).toBe("0");
    expect(canonicalizeJson(1e30)).toBe("1e+30");
    expect(canonicalizeJson(4.5)).toBe("4.5");
    expect(canonicalizeJson(0.002)).toBe("0.002");
    expect(canonicalizeJson(1e-27)).toBe("1e-27");
    expect(canonicalizeJson([333333333.3333333, 1e30, 4.5, 0.002, 1e-27])).toBe(
      "[333333333.3333333,1e+30,4.5,0.002,1e-27]",
    );
    const rfcKeys = ["\r", "1", "\u0080", "\u00f6", "\u20ac", "\ud83d\ude00", "\ufb33"];
    const sorted = [...rfcKeys].sort(compareCanonicalKeys);
    expect(sorted).toEqual(["\r", "1", "\u0080", "\u00f6", "\u20ac", "\ud83d\ude00", "\ufb33"]);
    expect(() => canonicalizeJson("abc\uD800")).toThrow(/lone surrogate/);
    expect(() => canonicalizeJson("\uD800A")).toThrow(/lone surrogate/);
    expect(() => canonicalizeJson({ ["k\uD800"]: 1 })).toThrow(/lone surrogate/);
  });

  test("hashCanonicalJson rejects lone surrogates without collapsing", async () => {
    await expect(Effect.runPromise(hashCanonicalJson("abc\uD800"))).rejects.toBeInstanceOf(
      InvalidIR,
    );
    await expect(Effect.runPromise(hashCanonicalJson({ ["k\uDEAD"]: 1 }))).rejects.toBeInstanceOf(
      InvalidIR,
    );
  });

  test("key order does not change the canonical document", async () => {
    const a = Effect.runSync(decodePolicyTemplate(clone(emptyTemplateEncoded)));
    const reordered = {
      version: 1,
      decisions: { operations: [], fields: [], traits: [], entities: [] },
      rules: [],
      principal: { subjectClaim: "sub" },
      claims: [],
      classes: [],
      _tag: "PolicyTemplateIR",
    };
    const b = Effect.runSync(decodePolicyTemplate(reordered));
    expect(canonicalizePolicyTemplate(a)).toBe(canonicalizePolicyTemplate(b));
    expect(await hashOf(hashPolicyTemplate(a))).toBe(await hashOf(hashPolicyTemplate(b)));
  });

  test("pretty and compact JSON decode to the same hash", async () => {
    const compact = JSON.parse(JSON.stringify(emptyTemplateEncoded));
    const pretty = JSON.parse(JSON.stringify(emptyTemplateEncoded, null, 2));
    const a = Effect.runSync(decodePolicyTemplate(compact));
    const b = Effect.runSync(decodePolicyTemplate(pretty));
    expect(await hashOf(hashPolicyTemplate(a))).toBe(await hashOf(hashPolicyTemplate(b)));
  });

  test("encode then decode is a stable round trip", async () => {
    const decoded = Effect.runSync(decodePolicyTemplate(clone(templateEncoded)));
    const encoded = encodePolicyTemplate(decoded);
    const again = Effect.runSync(decodePolicyTemplate(encoded));
    expect(canonicalizePolicyTemplate(decoded)).toBe(canonicalizePolicyTemplate(again));
    expect(await hashOf(hashRelativeRule(decoded.rules[0]))).toBe(
      await hashOf(hashRelativeRule(again.rules[0])),
    );
  });

  test("installed encode/decode is a stable round trip", async () => {
    const decoded = Effect.runSync(decodeInstalledAuthorization(clone(installedEncoded)));
    const encoded = encodeInstalledAuthorization(decoded);
    const again = Effect.runSync(decodeInstalledAuthorization(encoded));
    expect(canonicalizeInstalledAuthorization(decoded)).toBe(
      canonicalizeInstalledAuthorization(again),
    );
    expect(await hashOf(hashCanonicalRule(decoded.rules[0]))).toBe(
      await hashOf(hashCanonicalRule(again.rules[0])),
    );
    expect(await hashOf(hashInstalledAuthorization(decoded))).toBe(
      await hashOf(hashInstalledAuthorization(again)),
    );
  });

  test("golden empty template serialization", async () => {
    const decoded = Effect.runSync(decodePolicyTemplate(clone(emptyTemplateEncoded)));
    const canonical = canonicalizePolicyTemplate(decoded);
    expect(canonical).toBe(
      '{"_tag":"PolicyTemplateIR","claims":[],"classes":[],"decisions":{"entities":[],"fields":[],"operations":[],"traits":[]},"principal":{"subjectClaim":"sub"},"rules":[],"version":1}',
    );
    const digest = String(await hashOf(hashPolicyTemplate(decoded)));
    expect(digest).toBe("32ac5c7ad4ccc9acc9a03f3c7cc3ff0f7ba90b701db9a9eab5b5e360b140d01b");
    expect(await hashOf(hashCanonicalJson(JSON.parse(canonical) as JsonValue))).toBe(digest);
  });

  test("golden template and installed hashes are deterministic", async () => {
    const template = Effect.runSync(decodePolicyTemplate(clone(templateEncoded)));
    const installed = Effect.runSync(decodeInstalledAuthorization(clone(installedEncoded)));
    expect(String(await hashOf(hashPolicyTemplate(template)))).toBe(
      "ba3627858d639dc167115db4c66e8a1e3d112e56e7f8848bce4682ae85a121df",
    );
    expect(String(await hashOf(hashInstalledAuthorization(installed)))).toBe(
      "b58680da318ac5ffe27d603ac8174967718745da7724bb46e918339fd9ec258e",
    );
    expect(String(await hashOf(hashRelativeRule(template.rules[0])))).toBe(
      "706cf08602db9b325fad3bec8806bcc936a2b6471b61e09c5309444f1c6de666",
    );
    expect(String(await hashOf(hashRelativeRule(template.rules[1])))).toBe(
      "e389c245d4cdd49cb220f7c602d3c127f4bb9083c93378795afa3bafc40d4093",
    );
    expect(String(await hashOf(hashRelativeRule(template.rules[2])))).toBe(
      "38c66b8a272af0fbbe5bf2007cefb8aa91aa8da2ab52b1f6b0b724bf63b42d5e",
    );
    expect(String(await hashOf(hashCanonicalRule(installed.rules[0])))).toBe(
      "13fd64ba860771677735d3edf65497cef91393039bd51a8164524436802ea57b",
    );
  });

  test("installed policyHash is excluded from the document digest", async () => {
    const installed = Effect.runSync(decodeInstalledAuthorization(clone(installedEncoded)));
    const digest = await hashOf(hashInstalledAuthorization(installed));
    const encoded = encodeInstalledAuthorization(installed);
    const withDigest = Effect.runSync(
      decodeInstalledAuthorization({ ...encoded, policyHash: String(digest) }),
    );
    const withOther = Effect.runSync(
      decodeInstalledAuthorization({ ...encoded, policyHash: POLICY_HASH_OTHER }),
    );
    expect(await hashOf(hashInstalledAuthorization(withDigest))).toBe(digest);
    expect(await hashOf(hashInstalledAuthorization(withOther))).toBe(digest);
    expect(String(digest)).not.toBe(POLICY_HASH_PLACEHOLDER);
  });
});

describe("plain immutable data", () => {
  test("decoded IR is not a class or tagged-class instance", () => {
    const template = Effect.runSync(decodePolicyTemplate(clone(templateEncoded)));
    const installed = Effect.runSync(decodeInstalledAuthorization(clone(installedEncoded)));
    expect(template.constructor).toBe(Object);
    expect(installed.constructor).toBe(Object);
    expect(typeof (template as PolicyTemplateIR & { encode?: unknown }).encode).toBe(
      "undefined",
    );
    expect(typeof (installed as InstalledAuthorizationIR & { encode?: unknown }).encode).toBe(
      "undefined",
    );
  });
});
