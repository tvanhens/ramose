import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import {
  INSTALLED_AUTHORIZATION_IR_VERSION,
  InvalidIR,
  MAX_COLLECTION_SIZE,
  MAX_JSON_DEPTH,
  MAX_STRING_LENGTH,
  POLICY_TEMPLATE_IR_VERSION,
  canonicalizeInstalledAuthorization,
  canonicalizeJson,
  canonicalizePolicyTemplate,
  decodeInstalledAuthorization,
  decodeInstalledAuthorizationResult,
  decodePolicyTemplate,
  decodePolicyTemplateResult,
  encodeInstalledAuthorization,
  encodePolicyTemplate,
  hashCanonical,
  hashCanonicalRule,
  hashInstalledAuthorization,
  hashPolicyTemplate,
  hashRelativeRule,
  sha256Hex,
  type InstalledAuthorizationIR,
  type PolicyTemplateIR,
} from "../../../src/internal/authorization/index.ts";
import { emptyTemplateEncoded, installedEncoded, templateEncoded } from "./fixtures.ts";

const clone = <T>(value: T): T => structuredClone(value);

const expectInvalid = (result: Result.Result<unknown, InvalidIR>, pattern: RegExp) => {
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) {
    expect(result.failure).toBeInstanceOf(InvalidIR);
    expect(result.failure._tag).toBe("InvalidIR");
    expect(result.failure.message).toMatch(pattern);
  }
};

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

  test("rejects an accessor property", () => {
    const input = { ...emptyTemplateEncoded } as Record<string, unknown>;
    Object.defineProperty(input, "sneak", {
      enumerable: true,
      get: () => 1,
    });
    expectInvalid(decodePolicyTemplateResult(input), /prototype|JSON|function/);
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
            id: "r",
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

  test("rejects oversized depth", () => {
    let nested: unknown = null;
    for (let i = 0; i < MAX_JSON_DEPTH + 2; i++) nested = { child: nested };
    expectInvalid(
      decodePolicyTemplateResult({ ...emptyTemplateEncoded, extra: nested }),
      /oversized depth|JSON/,
    );
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
            id: "lit",
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
            id: "depth",
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
    const { catalog: _, ...rest } = installedEncoded;
    expectInvalid(decodeInstalledAuthorizationResult(rest), /catalog/i);
  });
});

describe("rule identity collisions", () => {
  test("fails closed when one rule id maps to different canonical bodies", () => {
    const colliding = {
      ...clone(emptyTemplateEncoded),
      rules: [
      {
        id: "same",
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
        id: "same",
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
      id: "same",
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
            { target: clone(target), decision: { allow: ["x"], deny: [] } },
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
          ...base.rules[0],
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
          entities: [base.identities.entities[0], base.identities.entities[0]],
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
          { rule: "owns-issue", lookups: [] },
        ],
      }),
      /access-plan identity collision/,
    );
  });
});

describe("canonical serialization", () => {
  test("SHA-256 empty-string vector", () => {
    expect(sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  test("SHA-256 NIST and multi-block vectors", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sha256Hex("hello")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
    expect(sha256Hex("a".repeat(1000))).toBe(
      "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3",
    );
  });

  test("key order does not change the canonical document", () => {
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
    expect(hashPolicyTemplate(a)).toBe(hashPolicyTemplate(b));
  });

  test("pretty and compact JSON decode to the same hash", () => {
    const compact = JSON.parse(JSON.stringify(emptyTemplateEncoded));
    const pretty = JSON.parse(JSON.stringify(emptyTemplateEncoded, null, 2));
    const a = Effect.runSync(decodePolicyTemplate(compact));
    const b = Effect.runSync(decodePolicyTemplate(pretty));
    expect(hashPolicyTemplate(a)).toBe(hashPolicyTemplate(b));
  });

  test("encode then decode is a stable round trip", () => {
    const decoded = Effect.runSync(decodePolicyTemplate(clone(templateEncoded)));
    const encoded = encodePolicyTemplate(decoded);
    const again = Effect.runSync(decodePolicyTemplate(encoded));
    expect(canonicalizePolicyTemplate(decoded)).toBe(canonicalizePolicyTemplate(again));
    expect(hashRelativeRule(decoded.rules[0])).toBe(hashRelativeRule(again.rules[0]));
  });

  test("installed encode/decode is a stable round trip", () => {
    const decoded = Effect.runSync(decodeInstalledAuthorization(clone(installedEncoded)));
    const encoded = encodeInstalledAuthorization(decoded);
    const again = Effect.runSync(decodeInstalledAuthorization(encoded));
    expect(canonicalizeInstalledAuthorization(decoded)).toBe(
      canonicalizeInstalledAuthorization(again),
    );
    expect(hashCanonicalRule(decoded.rules[0])).toBe(hashCanonicalRule(again.rules[0]));
    expect(hashInstalledAuthorization(decoded)).toBe(hashInstalledAuthorization(again));
  });

  test("golden empty template serialization", () => {
    const decoded = Effect.runSync(decodePolicyTemplate(clone(emptyTemplateEncoded)));
    const canonical = canonicalizePolicyTemplate(decoded);
    expect(canonical).toBe(
      '{"_tag":"PolicyTemplateIR","claims":[],"classes":[],"decisions":{"entities":[],"fields":[],"operations":[],"traits":[]},"principal":{"subjectClaim":"sub"},"rules":[],"version":1}',
    );
    expect(String(hashPolicyTemplate(decoded))).toBe(
      "32ac5c7ad4ccc9acc9a03f3c7cc3ff0f7ba90b701db9a9eab5b5e360b140d01b",
    );
    expect(hashCanonical(JSON.parse(canonical))).toBe(String(hashPolicyTemplate(decoded)));
  });

  test("golden template and installed hashes are deterministic", () => {
    const template = Effect.runSync(decodePolicyTemplate(clone(templateEncoded)));
    const installed = Effect.runSync(decodeInstalledAuthorization(clone(installedEncoded)));
    expect(String(hashPolicyTemplate(template))).toBe(
      "37938d247036d4c6151daf60d3102aff2782f8a12eff25ea01d386fd395bb71c",
    );
    expect(String(hashInstalledAuthorization(installed))).toBe(
      "ec682cb1a98ef237e5356beff30018b077c223cc72513b8652e99db2e0235378",
    );
    expect(canonicalizeJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(String(hashRelativeRule(template.rules[0]))).toBe(
      "706cf08602db9b325fad3bec8806bcc936a2b6471b61e09c5309444f1c6de666",
    );
    expect(String(hashRelativeRule(template.rules[1]))).toBe(
      "e389c245d4cdd49cb220f7c602d3c127f4bb9083c93378795afa3bafc40d4093",
    );
    expect(String(hashRelativeRule(template.rules[2]))).toBe(
      "38c66b8a272af0fbbe5bf2007cefb8aa91aa8da2ab52b1f6b0b724bf63b42d5e",
    );
    expect(String(hashCanonicalRule(installed.rules[0]))).toBe(
      "13fd64ba860771677735d3edf65497cef91393039bd51a8164524436802ea57b",
    );
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
