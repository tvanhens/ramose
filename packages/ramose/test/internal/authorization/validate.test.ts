/**
 * Core v1 semantic validation of catalog-bound authorization IR.
 *
 * Binding and structural decode are out of scope. Access-plan derivation
 * and installed-IR assembly live in install tests. Deferred language tests
 * belong in decode tests — they must fail before this kernel runs.
 */

import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import {
  AUTHORIZATION_LANGUAGE_VERSION,
  AUTHORIZATION_RULE_HASH_DOMAIN_V1,
  AuthoritativeCatalog,
  BOUND_AUTHORIZATION_IR_VERSION,
  CatalogId,
  CatalogMismatch,
  CatalogVersion,
  DatabaseId,
  EntityId,
  FieldId,
  InvalidIR,
  RuleId,
  SchemaFingerprint,
  TraitId,
  VALIDATED_AUTHORIZATION_IR_VERSION,
  bindPolicyTemplate,
  bindPolicyTemplateResult,
  hashCanonicalRule,
  hashDomainSeparatedCanonicalJson,
  validateBoundAuthorization,
  validateBoundAuthorizationResult,
  validateBoundAuthorizationResultForTest,
  type BoundAuthorizationIR,
  type CanonicalAuthorizationExpr,
  type CanonicalAuthorizationRule,
  type CanonicalRuleFocus,
  type CatalogBindingTarget,
  type CatalogDescriptor,
  type FieldRefTarget,
  type InstalledAuthorizationIR,
  type OwnerRef,
  type ValidatedAuthorizationIR,
} from "../../../src/internal/authorization/index.ts";
import { digestHex } from "./fixtures.ts";
import { operationMetadata } from "./operation-support.ts";

const catalog = CatalogId.make("app");
const database = DatabaseId.make("todos");
const version = CatalogVersion.make("1");
const fingerprint = SchemaFingerprint.make("schema");

const issueOwner = { kind: "entity" as const, name: "issue" };
const userOwner = { kind: "entity" as const, name: "user" };
const tagOwner = { kind: "entity" as const, name: "tag" };
const taggableOwner = { kind: "trait" as const, name: "taggable" };

const target: CatalogBindingTarget = {
  database,
  catalog,
  catalogVersion: version,
  schemaFingerprint: fingerprint,
};

const entity = (name: string) => EntityId.make({ catalog, name });
const trait = (name: string) => TraitId.make({ catalog, name });
const field = (owner: OwnerRef, localName: string) => FieldId.make({ catalog, owner, localName });

const scalarField = (
  owner: OwnerRef,
  localName: string,
  unique?: "upsert" | "strict",
): CatalogDescriptor["fields"][number] => ({
  id: field(owner, localName),
  valueType: "string",
  cardinality: "one",
  ...(unique === undefined ? {} : { unique }),
  index: unique !== undefined,
  optional: false,
  owned: false,
});

const refField = (
  owner: OwnerRef,
  localName: string,
  refTarget: FieldRefTarget,
  cardinality: "one" | "many" = "one",
): CatalogDescriptor["fields"][number] => ({
  id: field(owner, localName),
  valueType: "ref",
  refTarget,
  cardinality,
  index: false,
  optional: false,
  owned: false,
});

const catalogDescriptor = (): CatalogDescriptor => ({
  id: catalog,
  database,
  version,
  fingerprint,
  entities: [
    { id: entity("user"), traits: [] },
    { id: entity("issue"), traits: [trait("taggable")] },
    { id: entity("tag"), traits: [] },
  ],
  traits: [{ id: trait("taggable"), traits: [] }, { id: trait("orphaned"), traits: [] }],
  fields: [
    scalarField(userOwner, "authId", "upsert"),
    refField(issueOwner, "owner", { _tag: "entity", entity: entity("user") }),
    refField(issueOwner, "parent", { _tag: "self" }),
    refField(userOwner, "parent", { _tag: "self" }),
    scalarField(issueOwner, "title"),
    scalarField(issueOwner, "internalNotes"),
    refField(taggableOwner, "tags", { _tag: "entity", entity: entity("user") }, "many"),
    scalarField(tagOwner, "name"),
  ],
  operations: [
    {
      id: {
        _tag: "OperationId",
        catalog,
        owner: issueOwner,
        localName: "rename",
        target: "required",
      },
      ...operationMetadata(),
      input: {
        _tag: "struct",
        fields: [{ key: "title", optional: false, shape: { _tag: "scalar", valueType: "string" } }],
      },
    },
  ],
  traitComposition: [
    {
      composer: entity("issue"),
      trait: trait("taggable"),
      transitive: [trait("taggable")],
    },
  ],
});

const descriptor = catalogDescriptor();

const step = (owner: OwnerRef, localName: string) => ({ field: field(owner, localName) });

const resourceRef = (...steps: ReadonlyArray<{ field: ReturnType<typeof field> }>) =>
  ({ _tag: "ref" as const, root: { _tag: "resource" as const }, steps });

let stampSeq = 0;
const stamp = (
  focus: CanonicalRuleFocus,
  expr: CanonicalAuthorizationExpr,
  flags: Omit<CanonicalAuthorizationRule, "id" | "focus" | "expr">,
): CanonicalAuthorizationRule => {
  stampSeq += 1;
  return {
    id: RuleId.make(digestHex(stampSeq)),
    focus,
    expr,
    ...flags,
  };
};

const none = {
  usesResource: false,
  usesMe: false,
  usesSubject: false,
  traversalDepth: 0,
} as const;

const ownsIssue = () =>
  stamp(
    { _tag: "entity", entity: entity("issue") },
    {
      _tag: "eq",
      left: resourceRef(step(issueOwner, "owner")),
      right: { _tag: "me" },
    },
    { usesResource: true, usesMe: true, usesSubject: false, traversalDepth: 1 },
  );

const tenantClaim = () =>
  stamp(
    { _tag: "entity", entity: entity("issue") },
    {
      _tag: "and",
      exprs: [
        { _tag: "hasClass", class: "member" },
        { _tag: "eq", left: { _tag: "subject" }, right: { _tag: "claim", key: "org" } },
      ],
    },
    { ...none, usesSubject: true },
  );

const terminalMembership = () =>
  stamp(
    { _tag: "trait", trait: trait("taggable") },
    {
      _tag: "in",
      value: { _tag: "me" },
      collection: resourceRef(step(taggableOwner, "tags")),
    },
    { usesResource: true, usesMe: true, usesSubject: false, traversalDepth: 1 },
  );

const fieldRule = () =>
  stamp({ _tag: "field", field: field(issueOwner, "internalNotes") }, { _tag: "hasClass", class: "member" }, none);

const alwaysTrue = (focus: CanonicalRuleFocus) => stamp(focus, { _tag: "const", value: true }, none);

const boundDocument = (
  rules: ReadonlyArray<CanonicalAuthorizationRule>,
  decisions: BoundAuthorizationIR["decisions"] = {
    entities: [],
    traits: [],
    fields: [],
  },
  extras: Partial<BoundAuthorizationIR> = {},
): BoundAuthorizationIR => ({
  _tag: "BoundAuthorizationIR",
  version: BOUND_AUTHORIZATION_IR_VERSION,
  languageVersion: AUTHORIZATION_LANGUAGE_VERSION,
  database,
  catalog,
  catalogVersion: version,
  schemaFingerprint: fingerprint,
  classes: ["member"],
  claims: [
    { key: "org", optional: false, shape: { _tag: "scalar", valueType: "string" } },
    {
      key: "teams",
      optional: true,
      shape: { _tag: "array", items: { _tag: "scalar", valueType: "string" } },
    },
  ],
  principal: { subjectClaim: "sub", entity: field(userOwner, "authId") },
  rules,
  decisions,
  ...extras,
});

const expectValidated = (
  result: Result.Result<ValidatedAuthorizationIR, InvalidIR | CatalogMismatch>,
) => {
  if (Result.isFailure(result)) throw result.failure;
  return result.success;
};

const expectFailure = (
  result: Result.Result<unknown, InvalidIR | CatalogMismatch>,
  tag: "InvalidIR" | "CatalogMismatch",
  pattern: RegExp,
) => {
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isSuccess(result)) throw new Error("expected validation failure");
  expect(result.failure._tag).toBe(tag);
  expect(result.failure.message).toMatch(pattern);
  expect(result.failure._tag).not.toBe("AuthorizationDenied");
};

const requireInstalled = (_ir: InstalledAuthorizationIR): void => undefined;

describe("successful validation", () => {
  test("validates ownership, trait reuse, field narrowing, subject/claim, class, and membership", () => {
    const owns = ownsIssue();
    const tenant = tenantClaim();
    const membership = terminalMembership();
    const notes = fieldRule();
    const validated = expectValidated(
      validateBoundAuthorizationResult({
        bound: boundDocument(
          [owns, tenant, membership, notes],
          {
            entities: [
              {
                target: entity("issue"),
                decision: { allow: [owns.id, tenant.id], deny: [] },
              },
            ],
            traits: [{ target: trait("taggable"), decision: { allow: [membership.id], deny: [] } }],
            fields: [
              {
                target: field(issueOwner, "internalNotes"),
                decision: { allow: [notes.id], deny: [] },
              },
            ],
          },
        ),
        descriptor,
      }),
    );
    expect(validated._tag).toBe("ValidatedAuthorizationIR");
    expect(validated.languageVersion).toBe(AUTHORIZATION_LANGUAGE_VERSION);
    expect(validated.version).toBe(VALIDATED_AUTHORIZATION_IR_VERSION);
    expect(validated.rules).toHaveLength(4);
    expect(Object.isFrozen(validated)).toBe(true);
    expect("policyHash" in validated).toBe(false);
    expect("accessPlans" in validated).toBe(false);
  });

  test("accepts nested cardinality-one ownership", () => {
    const rule = stamp(
      { _tag: "entity", entity: entity("issue") },
      {
        _tag: "eq",
        left: resourceRef(step(issueOwner, "parent"), step(issueOwner, "owner")),
        right: { _tag: "me" },
      },
      { usesResource: true, usesMe: true, usesSubject: false, traversalDepth: 2 },
    );
    expectValidated(validateBoundAuthorizationResult({ bound: boundDocument([rule]), descriptor }));
  });

  test("missing me is a runtime completeness concern", () => {
    const rule = alwaysTrue({ _tag: "entity", entity: entity("issue") });
    expectValidated(
      validateBoundAuthorizationResult({
        bound: boundDocument([rule], undefined, { principal: { subjectClaim: "sub" } }),
        descriptor,
      }),
    );
  });

  test("trait-focused rule can authorize a composing entity", () => {
    const membership = terminalMembership();
    expectValidated(
      validateBoundAuthorizationResult({
        bound: boundDocument([membership], {
          entities: [{ target: entity("issue"), decision: { allow: [membership.id], deny: [] } }],
          traits: [],
          fields: [],
        }),
        descriptor,
      }),
    );
  });

  test("accepts presence of a terminal many-valued ref", () => {
    const rule = stamp(
      { _tag: "trait", trait: trait("taggable") },
      { _tag: "has", term: resourceRef(step(taggableOwner, "tags")) },
      { usesResource: true, usesMe: false, usesSubject: false, traversalDepth: 1 },
    );
    expectValidated(validateBoundAuthorizationResult({ bound: boundDocument([rule]), descriptor }));
  });

  test("accepts a one-dimensional scalar claim array as a collection", () => {
    const rule = stamp(
      { _tag: "entity", entity: entity("issue") },
      {
        _tag: "in",
        value: { _tag: "lit", value: "eng" },
        collection: { _tag: "claim", key: "teams" },
      },
      none,
    );
    expectValidated(validateBoundAuthorizationResult({ bound: boundDocument([rule]), descriptor }));
  });
});

describe("tampered derived metadata", () => {
  const flags: Array<"usesResource" | "usesMe" | "usesSubject" | "traversalDepth"> = [
    "usesResource",
    "usesMe",
    "usesSubject",
    "traversalDepth",
  ];
  test.each(flags)("rejects a tampered %s", (flag) => {
    const honest = ownsIssue();
    const tampered = {
      ...honest,
      [flag]: flag === "traversalDepth" ? honest.traversalDepth + 1 : !honest[flag],
    };
    expectFailure(
      validateBoundAuthorizationResult({ bound: boundDocument([tampered]), descriptor }),
      "InvalidIR",
      new RegExp(`tampered ${flag}`),
    );
  });

  test("rejects a tampered rule id on the Effect hash shell", async () => {
    const honest = ownsIssue();
    const expected = await Effect.runPromise(hashCanonicalRule(honest));
    const stamped = { ...honest, id: expected };
    const ok = await Effect.runPromise(
      validateBoundAuthorization({ bound: boundDocument([stamped]), descriptor }),
    );
    expect(ok.rules[0]?.id).toBe(expected);

    const wrongDomain = await Effect.runPromise(
      hashDomainSeparatedCanonicalJson("ramose.authorization.rule/v2\0", {
        focus: stamped.focus,
        expr: stamped.expr,
      }),
    );
    const failure = await Effect.runPromise(
      Effect.flip(
        validateBoundAuthorization({
          bound: boundDocument([{ ...stamped, id: RuleId.make(wrongDomain) }]),
          descriptor,
        }),
      ),
    );
    expect(failure).toBeInstanceOf(InvalidIR);
    expect(failure.message).toMatch(/tampered rule id/);
  });
});

describe("owned operation descriptors", () => {
  test("rejects nested self references on a targetless operation", () => {
    const operation = descriptor.operations[0]!;
    const patched: CatalogDescriptor = {
      ...descriptor,
      operations: [
        {
          ...operation,
          id: { ...operation.id, target: "none" },
          input: {
            _tag: "struct",
            fields: [
              {
                key: "nested",
                optional: false,
                shape: {
                  _tag: "array",
                  items: { _tag: "ref", refTarget: { _tag: "self" } },
                },
              },
            ],
          },
        },
      ],
    };
    expectFailure(
      validateBoundAuthorizationResult({ bound: boundDocument([]), descriptor: patched }),
      "InvalidIR",
      /targetless operation 'issue\.rename' cannot reference self/,
    );
  });

  test("rejects operation schema refs to missing catalog types", () => {
    const operation = descriptor.operations[0]!;
    const patched: CatalogDescriptor = {
      ...descriptor,
      operations: [
        {
          ...operation,
          input: {
            _tag: "ref",
            refTarget: { _tag: "entity", entity: entity("missing") },
          },
        },
      ],
    };
    expectFailure(
      validateBoundAuthorizationResult({ bound: boundDocument([]), descriptor: patched }),
      "InvalidIR",
      /missing field ref target entity 'missing'/,
    );
  });

  test("rejects missing and duplicate operation write dependencies", () => {
    const operation = descriptor.operations[0]!;
    const withWrites = (
      writes: CatalogDescriptor["operations"][number]["writes"],
    ): CatalogDescriptor => ({
      ...descriptor,
      operations: [{ ...operation, writes }],
    });
    expectFailure(
      validateBoundAuthorizationResult({
        bound: boundDocument([]),
        descriptor: withWrites([entity("missing")]),
      }),
      "InvalidIR",
      /missing operation write entity 'missing'/,
    );
    expectFailure(
      validateBoundAuthorizationResult({
        bound: boundDocument([]),
        descriptor: withWrites([entity("issue"), entity("issue")]),
      }),
      "InvalidIR",
      /duplicate operation write entity 'issue'/,
    );
  });

  test("rejects targetless operations owned by unreachable traits", () => {
    const operation = descriptor.operations[0]!;
    const patched: CatalogDescriptor = {
      ...descriptor,
      operations: [
        {
          ...operation,
          id: {
            ...operation.id,
            owner: { kind: "trait", name: "orphaned" },
            target: "none",
          },
        },
      ],
    };
    expectFailure(
      validateBoundAuthorizationResult({ bound: boundDocument([]), descriptor: patched }),
      "InvalidIR",
      /unreachable trait operation owner 'orphaned'/,
    );
  });

  test("rejects blank operation documentation", () => {
    const operation = descriptor.operations[0]!;
    const patched: CatalogDescriptor = {
      ...descriptor,
      operations: [{ ...operation, doc: "" }],
    };
    expectFailure(
      validateBoundAuthorizationResult({ bound: boundDocument([]), descriptor: patched }),
      "InvalidIR",
      /blank operation doc/,
    );
  });

  test("rejects blank entity, trait, and field documentation", () => {
    const cases: ReadonlyArray<{
      readonly label: string;
      readonly descriptor: CatalogDescriptor;
      readonly pattern: RegExp;
    }> = [
      {
        label: "entity",
        descriptor: {
          ...descriptor,
          entities: descriptor.entities.map((entry, index) =>
            index === 0 ? { ...entry, doc: " \n" } : entry
          ),
        },
        pattern: /blank entity doc/,
      },
      {
        label: "trait",
        descriptor: {
          ...descriptor,
          traits: descriptor.traits.map((entry, index) =>
            index === 0 ? { ...entry, doc: "\t" } : entry
          ),
        },
        pattern: /blank trait doc/,
      },
      {
        label: "field",
        descriptor: {
          ...descriptor,
          fields: descriptor.fields.map((entry, index) =>
            index === 0 ? { ...entry, doc: "" } : entry
          ),
        },
        pattern: /blank field doc/,
      },
    ];

    for (const testCase of cases) {
      const result = validateBoundAuthorizationResult({
        bound: boundDocument([]),
        descriptor: testCase.descriptor,
      });
      if (Result.isSuccess(result)) {
        throw new Error(`expected blank ${testCase.label} documentation to fail`);
      }
      expectFailure(
        result,
        "InvalidIR",
        testCase.pattern,
      );
    }
  });
});

describe("traversal", () => {
  test("rejects a field owned by the wrong entity", () => {
    const rule = stamp(
      { _tag: "entity", entity: entity("issue") },
      {
        _tag: "eq",
        left: resourceRef(step(userOwner, "authId")),
        right: { _tag: "subject" },
      },
      { usesResource: true, usesMe: false, usesSubject: true, traversalDepth: 1 },
    );
    expectFailure(
      validateBoundAuthorizationResult({ bound: boundDocument([rule]), descriptor }),
      "InvalidIR",
      /wrong owner/,
    );
  });

  test("rejects a field that does not exist on the owner", () => {
    const rule = stamp(
      { _tag: "entity", entity: entity("issue") },
      {
        _tag: "eq",
        left: resourceRef(step(issueOwner, "reporter")),
        right: { _tag: "me" },
      },
      { usesResource: true, usesMe: true, usesSubject: false, traversalDepth: 1 },
    );
    expectFailure(
      validateBoundAuthorizationResult({ bound: boundDocument([rule]), descriptor }),
      "InvalidIR",
      /stale identity|missing traversal field/,
    );
  });

  test("rejects traversal through a non-ref field", () => {
    const rule = stamp(
      { _tag: "entity", entity: entity("issue") },
      {
        _tag: "eq",
        left: resourceRef(step(issueOwner, "title"), step(issueOwner, "owner")),
        right: { _tag: "me" },
      },
      { usesResource: true, usesMe: true, usesSubject: false, traversalDepth: 2 },
    );
    expectFailure(
      validateBoundAuthorizationResult({ bound: boundDocument([rule]), descriptor }),
      "InvalidIR",
      /non-ref traversal/,
    );
  });

  test("rejects a hop whose field belongs to the wrong ref target", () => {
    const rule = stamp(
      { _tag: "entity", entity: entity("issue") },
      {
        _tag: "eq",
        left: resourceRef(step(issueOwner, "owner"), step(issueOwner, "title")),
        right: { _tag: "lit", value: "x" },
      },
      { usesResource: true, usesMe: false, usesSubject: false, traversalDepth: 2 },
    );
    expectFailure(
      validateBoundAuthorizationResult({ bound: boundDocument([rule]), descriptor }),
      "InvalidIR",
      /wrong owner/,
    );
  });

  test("rejects excessive traversal depth", () => {
    const rule = stamp(
      { _tag: "entity", entity: entity("issue") },
      {
        _tag: "eq",
        left: resourceRef(
          step(issueOwner, "parent"),
          step(issueOwner, "parent"),
          step(issueOwner, "parent"),
          step(issueOwner, "owner"),
        ),
        right: { _tag: "me" },
      },
      { usesResource: true, usesMe: true, usesSubject: false, traversalDepth: 4 },
    );
    expectFailure(
      validateBoundAuthorizationResult({ bound: boundDocument([rule]), descriptor }),
      "InvalidIR",
      /traversal depth 4 exceeds 3/,
    );
  });

  test("rejects intermediate many-valued traversal", () => {
    const rule = stamp(
      { _tag: "trait", trait: trait("taggable") },
      {
        _tag: "eq",
        left: resourceRef(step(taggableOwner, "tags"), step(userOwner, "authId")),
        right: { _tag: "subject" },
      },
      { usesResource: true, usesMe: false, usesSubject: true, traversalDepth: 2 },
    );
    expectFailure(
      validateBoundAuthorizationResult({ bound: boundDocument([rule]), descriptor }),
      "InvalidIR",
      /intermediate many-valued traversal/,
    );
  });

  test("resolves self refs relative to their owners", () => {
    const rule = stamp(
      { _tag: "entity", entity: entity("issue") },
      {
        _tag: "eq",
        left: resourceRef(step(issueOwner, "parent"), step(issueOwner, "owner")),
        right: { _tag: "me" },
      },
      { usesResource: true, usesMe: true, usesSubject: false, traversalDepth: 2 },
    );
    expectValidated(validateBoundAuthorizationResult({ bound: boundDocument([rule]), descriptor }));
  });

  test("rejects a stale field identity from another catalog", () => {
    const other = CatalogId.make("other");
    const rule = stamp(
      { _tag: "entity", entity: entity("issue") },
      {
        _tag: "eq",
        left: {
          _tag: "ref",
          root: { _tag: "resource" },
          steps: [{ field: FieldId.make({ catalog: other, owner: issueOwner, localName: "owner" }) }],
        },
        right: { _tag: "me" },
      },
      { usesResource: true, usesMe: true, usesSubject: false, traversalDepth: 1 },
    );
    expectFailure(
      validateBoundAuthorizationResult({ bound: boundDocument([rule]), descriptor }),
      "CatalogMismatch",
      /stale identity|cross-catalog/,
    );
  });
});

describe("me, claims, and classes", () => {
  test("rejects structurally invalid me equality", () => {
    const rule = stamp(
      { _tag: "entity", entity: entity("issue") },
      { _tag: "eq", left: { _tag: "me" }, right: { _tag: "lit", value: "alice" } },
      { ...none, usesMe: true },
    );
    expectFailure(
      validateBoundAuthorizationResult({ bound: boundDocument([rule]), descriptor }),
      "InvalidIR",
      /incompatible equality/,
    );
  });

  test("rejects me traversal without a principal entity", () => {
    const rule = stamp(
      { _tag: "entity", entity: entity("issue") },
      {
        _tag: "eq",
        left: { _tag: "ref", root: { _tag: "me" }, steps: [step(userOwner, "authId")] },
        right: { _tag: "subject" },
      },
      { usesResource: false, usesMe: true, usesSubject: true, traversalDepth: 1 },
    );
    expectFailure(
      validateBoundAuthorizationResult({
        bound: boundDocument([rule], undefined, { principal: { subjectClaim: "sub" } }),
        descriptor,
      }),
      "InvalidIR",
      /structurally invalid me traversal/,
    );
  });

  test("accepts a declared claim and class", () => {
    expectValidated(
      validateBoundAuthorizationResult({ bound: boundDocument([tenantClaim()]), descriptor }),
    );
  });

  test("rejects an undeclared claim", () => {
    const rule = stamp(
      { _tag: "entity", entity: entity("issue") },
      { _tag: "eq", left: { _tag: "claim", key: "role" }, right: { _tag: "lit", value: "admin" } },
      none,
    );
    expectFailure(
      validateBoundAuthorizationResult({ bound: boundDocument([rule]), descriptor }),
      "InvalidIR",
      /undeclared claim 'role'/,
    );
  });

  test("rejects an undeclared class", () => {
    const rule = stamp(
      { _tag: "entity", entity: entity("issue") },
      { _tag: "hasClass", class: "admin" },
      none,
    );
    expectFailure(
      validateBoundAuthorizationResult({ bound: boundDocument([rule]), descriptor }),
      "InvalidIR",
      /undeclared class 'admin'/,
    );
  });

  test("rejects a blank principal subject claim", () => {
    expectFailure(
      validateBoundAuthorizationResult({
        bound: boundDocument([], undefined, { principal: { subjectClaim: "" } }),
        descriptor,
      }),
      "InvalidIR",
      /blank principal subject claim/,
    );
  });

  test("rejects a non-string principal lookup field", () => {
    const patched: CatalogDescriptor = {
      ...descriptor,
      fields: descriptor.fields.map((entry) =>
        entry.id.localName === "authId" ? { ...entry, valueType: "long" as const } : entry,
      ),
    };
    expectFailure(
      validateBoundAuthorizationResult({ bound: boundDocument([]), descriptor: patched }),
      "InvalidIR",
      /principal field must be string-compatible/,
    );
  });

  test("accepts a uuid principal lookup field", () => {
    const patched: CatalogDescriptor = {
      ...descriptor,
      fields: descriptor.fields.map((entry) =>
        entry.id.localName === "authId" ? { ...entry, valueType: "uuid" as const } : entry,
      ),
    };
    expectValidated(validateBoundAuthorizationResult({ bound: boundDocument([]), descriptor: patched }));
  });

  test("accepts eq of a composing resource owner and me", () => {
    expectValidated(
      validateBoundAuthorizationResult({ bound: boundDocument([ownsIssue()]), descriptor }),
    );
  });
});

describe("catalog trait composition", () => {
  test("rejects extra traits declared in the derived transitive closure", () => {
    const patched: CatalogDescriptor = {
      ...descriptor,
      traitComposition: [
        {
          composer: entity("issue"),
          trait: trait("taggable"),
          transitive: [trait("taggable"), trait("orphaned")],
        },
      ],
    };
    expectFailure(
      validateBoundAuthorizationResult({ bound: boundDocument([]), descriptor: patched }),
      "InvalidIR",
      /contradictory trait composition/,
    );
  });

  test("rejects a trait composition cycle instead of folding it into the closure", () => {
    const patched: CatalogDescriptor = {
      ...descriptor,
      traits: [
        { id: trait("taggable"), traits: [trait("orphaned")] },
        { id: trait("orphaned"), traits: [trait("taggable")] },
      ],
    };
    expectFailure(
      validateBoundAuthorizationResult({ bound: boundDocument([]), descriptor: patched }),
      "InvalidIR",
      /trait composition cycle/,
    );
  });

  test("rejects a missing compiled composition row for a direct entity trait", () => {
    const patched: CatalogDescriptor = { ...descriptor, traitComposition: [] };
    expectFailure(
      validateBoundAuthorizationResult({ bound: boundDocument([]), descriptor: patched }),
      "InvalidIR",
      /missing trait composition/,
    );
  });
});

describe("decision and focus compatibility", () => {
  test("rejects an unknown decision target", () => {
    expectFailure(
      validateBoundAuthorizationResult({
        bound: boundDocument([], {
          entities: [{ target: entity("project"), decision: { allow: [], deny: [] } }],
          traits: [],
          fields: [],
        }),
        descriptor,
      }),
      "InvalidIR",
      /stale identity|missing entity decision target/,
    );
  });

  test("rejects an unknown rule reference", () => {
    expectFailure(
      validateBoundAuthorizationResult({
        bound: boundDocument([], {
          entities: [
            {
              target: entity("issue"),
              decision: { allow: [RuleId.make(digestHex(0xab))], deny: [] },
            },
          ],
          traits: [],
          fields: [],
        }),
        descriptor,
      }),
      "InvalidIR",
      /unknown rule/,
    );
  });

  test("rejects a duplicate decision target", () => {
    expectFailure(
      validateBoundAuthorizationResult({
        bound: boundDocument([], {
          entities: [
            { target: entity("issue"), decision: { allow: [], deny: [] } },
            { target: entity("issue"), decision: { allow: [], deny: [] } },
          ],
          traits: [],
          fields: [],
        }),
        descriptor,
      }),
      "InvalidIR",
      /duplicate entity decision target/,
    );
  });

  test("rejects a contradictory allow and deny", () => {
    const rule = alwaysTrue({ _tag: "entity", entity: entity("issue") });
    expectFailure(
      validateBoundAuthorizationResult({
        bound: boundDocument([rule], {
          entities: [
            { target: entity("issue"), decision: { allow: [rule.id], deny: [rule.id] } },
          ],
          traits: [],
          fields: [],
        }),
        descriptor,
      }),
      "InvalidIR",
      /contradictory allow and deny/,
    );
  });

  test("rejects an entity rule on a trait decision", () => {
    const rule = ownsIssue();
    expectFailure(
      validateBoundAuthorizationResult({
        bound: boundDocument([rule], {
          entities: [],
          traits: [{ target: trait("taggable"), decision: { allow: [rule.id], deny: [] } }],
          fields: [],
        }),
        descriptor,
      }),
      "InvalidIR",
      /incompatible with trait decision/,
    );
  });

  test("rejects a field rule on an entity decision", () => {
    const rule = fieldRule();
    expectFailure(
      validateBoundAuthorizationResult({
        bound: boundDocument([rule], {
          entities: [{ target: entity("issue"), decision: { allow: [rule.id], deny: [] } }],
          traits: [],
          fields: [],
        }),
        descriptor,
      }),
      "InvalidIR",
      /incompatible with entity decision/,
    );
  });

  test("accepts an entity rule on a field of that entity", () => {
    const rule = ownsIssue();
    expectValidated(
      validateBoundAuthorizationResult({
        bound: boundDocument([rule], {
          entities: [],
          traits: [],
          fields: [
            { target: field(issueOwner, "title"), decision: { allow: [rule.id], deny: [] } },
          ],
        }),
        descriptor,
      }),
    );
  });

  test("rejects an entity-focused rule on a trait-owned field", () => {
    const rule = ownsIssue();
    expectFailure(
      validateBoundAuthorizationResult({
        bound: boundDocument([rule], {
          entities: [],
          traits: [],
          fields: [
            { target: field(taggableOwner, "tags"), decision: { allow: [rule.id], deny: [] } },
          ],
        }),
        descriptor,
      }),
      "InvalidIR",
      /incompatible with field decision/,
    );
  });

  test("missing decisions remain valid (deny by downstream semantics)", () => {
    expectValidated(
      validateBoundAuthorizationResult({ bound: boundDocument([ownsIssue()]), descriptor }),
    );
  });
});

describe("bounds", () => {
  test("accepts traversal depth at the limit", () => {
    const rule = stamp(
      { _tag: "entity", entity: entity("issue") },
      {
        _tag: "eq",
        left: resourceRef(
          step(issueOwner, "parent"),
          step(issueOwner, "parent"),
          step(issueOwner, "owner"),
        ),
        right: { _tag: "me" },
      },
      { usesResource: true, usesMe: true, usesSubject: false, traversalDepth: 3 },
    );
    expectValidated(validateBoundAuthorizationResult({ bound: boundDocument([rule]), descriptor }));
  });

  test("rejects a static work budget overflow", () => {
    expectFailure(
      validateBoundAuthorizationResultForTest(
        { bound: boundDocument([ownsIssue()]), descriptor },
        { maxStaticWork: 1 },
      ),
      "InvalidIR",
      /static work/,
    );
  });

  test("rejects non-finite test limit overrides", () => {
    expectFailure(
      validateBoundAuthorizationResultForTest(
        { bound: boundDocument([]), descriptor },
        { maxStaticWork: Number.POSITIVE_INFINITY },
      ),
      "InvalidIR",
      /invalid maxStaticWork/,
    );
  });

  test("clamps test overrides so callers cannot widen hard limits", () => {
    const rule = stamp(
      { _tag: "entity", entity: entity("issue") },
      {
        _tag: "eq",
        left: resourceRef(
          step(issueOwner, "parent"),
          step(issueOwner, "parent"),
          step(issueOwner, "parent"),
          step(issueOwner, "owner"),
        ),
        right: { _tag: "me" },
      },
      { usesResource: true, usesMe: true, usesSubject: false, traversalDepth: 4 },
    );
    expectFailure(
      validateBoundAuthorizationResultForTest(
        { bound: boundDocument([rule]), descriptor },
        { maxTraversalDepth: 10 },
      ),
      "InvalidIR",
      /traversal depth 4 exceeds 3/,
    );
  });
});

describe("determinism and hashing", () => {
  test("v1 rule hashes are domain-separated and deterministic", async () => {
    const rule = ownsIssue();
    const first = await Effect.runPromise(hashCanonicalRule(rule));
    const second = await Effect.runPromise(hashCanonicalRule(rule));
    expect(first).toBe(second);
    const unprefixed = await Effect.runPromise(
      hashDomainSeparatedCanonicalJson("", {
        focus: rule.focus,
        expr: rule.expr,
        usesMe: rule.usesMe,
        usesResource: rule.usesResource,
        usesSubject: rule.usesSubject,
        traversalDepth: rule.traversalDepth,
      }),
    );
    expect(first).not.toBe(unprefixed);
    expect(AUTHORIZATION_RULE_HASH_DOMAIN_V1.endsWith("\0")).toBe(true);
  });
});

describe("purity", () => {
  test("expression traversal does not perform Effect or service lookup", () => {
    const before = Date.now();
    expectValidated(
      validateBoundAuthorizationResult({ bound: boundDocument([ownsIssue()]), descriptor }),
    );
    expect(Date.now() - before).toBeLessThan(1_000);
  });

  test("validateBoundAuthorization surfaces InvalidIR on the failure channel", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        validateBoundAuthorization({
          bound: boundDocument([
            { ...ownsIssue(), usesResource: false },
          ]),
          descriptor,
        }),
      ),
    );
    expect(failure).toBeInstanceOf(InvalidIR);
    expect(failure.message).toMatch(/tampered usesResource/);
  });

  test("validateBoundAuthorization surfaces CatalogMismatch on the failure channel", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        validateBoundAuthorization({
          bound: boundDocument([], undefined, { catalog: CatalogId.make("other") }),
          descriptor,
        }),
      ),
    );
    expect(failure).toBeInstanceOf(CatalogMismatch);
  });

  test("AuthoritativeCatalog is not consulted by the kernel", async () => {
    let resolves = 0;
    const service = {
      resolve: () => {
        resolves += 1;
        return Effect.succeed(descriptor);
      },
    };
    expectValidated(
      validateBoundAuthorizationResult({ bound: boundDocument([ownsIssue()]), descriptor }),
    );
    await Effect.runPromise(
      Effect.void.pipe(Effect.provideService(AuthoritativeCatalog, service)),
    );
    expect(resolves).toBe(0);
  });
});

describe("type distinction", () => {
  test("validated IR is not installed IR", () => {
    const validated = expectValidated(
      validateBoundAuthorizationResult({ bound: boundDocument([]), descriptor }),
    );
    // @ts-expect-error — validated intermediate is not installed IR
    requireInstalled(validated);
    expect(validated._tag).toBe("ValidatedAuthorizationIR");
  });
});

describe("first-failure order", () => {
  test("the first rule fails before a later missing field", () => {
    const first = stamp(
      { _tag: "entity", entity: entity("issue") },
      { _tag: "hasClass", class: "ghost" },
      none,
    );
    const second = stamp(
      { _tag: "entity", entity: entity("issue") },
      {
        _tag: "eq",
        left: resourceRef(step(issueOwner, "missing-later")),
        right: { _tag: "me" },
      },
      { usesResource: true, usesMe: true, usesSubject: false, traversalDepth: 1 },
    );
    expectFailure(
      validateBoundAuthorizationResult({ bound: boundDocument([first, second]), descriptor }),
      "InvalidIR",
      /undeclared class 'ghost'/,
    );
  });

  test("eq walks the left operand before the right operand", () => {
    const rule = stamp(
      { _tag: "entity", entity: entity("issue") },
      {
        _tag: "eq",
        left: resourceRef(step(issueOwner, "missing-left")),
        right: { _tag: "claim", key: "undeclared-right" },
      },
      { usesResource: true, usesMe: false, usesSubject: false, traversalDepth: 1 },
    );
    expectFailure(
      validateBoundAuthorizationResult({ bound: boundDocument([rule]), descriptor }),
      "InvalidIR",
      /wrong owner for field 'entity:issue\.missing-left'|stale identity: missing traversal field/,
    );
  });
});

describe("bind then validate", () => {
  test("a correctly flagged bound template validates without restamping", async () => {
    const bound = Result.getOrThrow(
      bindPolicyTemplateResult({
        target,
        descriptor,
        template: {
          _tag: "PolicyTemplateIR",
          version: 1,
          languageVersion: AUTHORIZATION_LANGUAGE_VERSION,
          classes: ["member"],
          claims: [{ key: "org", optional: false, shape: { _tag: "scalar", valueType: "string" } }],
          principal: {
            subjectClaim: "sub",
            entity: { _tag: "RelativeFieldId", owner: userOwner, localName: "authId" },
          },
          rules: [
            {
              id: RuleId.make(digestHex(0x11)),
              focus: { _tag: "entity", entity: { _tag: "RelativeEntityId", name: "issue" } },
              expr: {
                _tag: "eq",
                left: {
                  _tag: "ref",
                  root: { _tag: "resource" },
                  steps: [{ field: { _tag: "RelativeFieldId", owner: issueOwner, localName: "owner" } }],
                },
                right: { _tag: "me" },
              },
              usesResource: true,
              usesMe: true,
              usesSubject: false,
              traversalDepth: 1,
            },
          ],
          decisions: {
            entities: [
              {
                target: { _tag: "RelativeEntityId", name: "issue" },
                decision: { allow: [RuleId.make(digestHex(0x11))], deny: [] },
              },
            ],
            traits: [],
            fields: [],
          },
        },
      }),
    );
    const validated = expectValidated(
      validateBoundAuthorizationResult({ bound, descriptor }),
    );
    expect(validated.rules[0]?.id).toBe(bound.rules[0]?.id);

    const remapped = await Effect.runPromise(
      bindPolicyTemplate({
        target,
        descriptor,
        template: {
          _tag: "PolicyTemplateIR",
          version: 1,
          languageVersion: AUTHORIZATION_LANGUAGE_VERSION,
          classes: ["member"],
          claims: [{ key: "org", optional: false, shape: { _tag: "scalar", valueType: "string" } }],
          principal: {
            subjectClaim: "sub",
            entity: { _tag: "RelativeFieldId", owner: userOwner, localName: "authId" },
          },
          rules: [
            {
              id: RuleId.make(digestHex(0x11)),
              focus: { _tag: "entity", entity: { _tag: "RelativeEntityId", name: "issue" } },
              expr: {
                _tag: "eq",
                left: {
                  _tag: "ref",
                  root: { _tag: "resource" },
                  steps: [{ field: { _tag: "RelativeFieldId", owner: issueOwner, localName: "owner" } }],
                },
                right: { _tag: "me" },
              },
              usesResource: true,
              usesMe: true,
              usesSubject: false,
              traversalDepth: 1,
            },
          ],
          decisions: {
            entities: [
              {
                target: { _tag: "RelativeEntityId", name: "issue" },
                decision: { allow: [RuleId.make(digestHex(0x11))], deny: [] },
              },
            ],
            traits: [],
            fields: [],
          },
        },
      }),
    );
    const checked = await Effect.runPromise(
      validateBoundAuthorization({ bound: remapped, descriptor }),
    );
    expect(checked.rules[0]?.id).toBe(remapped.rules[0]?.id);
  });
});
