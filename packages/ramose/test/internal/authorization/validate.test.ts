/**
 * Semantic validation of catalog-bound authorization IR.
 *
 * Binding and structural decode are out of scope. Access-plan derivation
 * and installed-IR assembly are later slices.
 */

import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import {
  AuthoritativeCatalog,
  BOUND_AUTHORIZATION_IR_VERSION,
  CatalogId,
  CatalogMismatch,
  CatalogVersion,
  DatabaseId,
  EntityId,
  FieldId,
  InvalidIR,
  OperationId,
  RuleId,
  SchemaFingerprint,
  TraitId,
  VALIDATED_AUTHORIZATION_IR_VERSION,
  bindPolicyTemplateResult,
  hashCanonicalRule,
  hashCanonicalRuleSync,
  sha256HexSync,
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

const catalog = CatalogId.make("app");
const database = DatabaseId.make("todos");
const version = CatalogVersion.make("1");
const fingerprint = SchemaFingerprint.make("schema");

const issueOwner = { kind: "entity" as const, name: "issue" };
const userOwner = { kind: "entity" as const, name: "user" };
const grantOwner = { kind: "entity" as const, name: "tag-grant" };
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
const operation = (owner: OwnerRef, localName: string, operationTarget: "required" | "none") =>
  OperationId.make({ catalog, owner, localName, target: operationTarget });

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
    { id: entity("tag-grant"), traits: [] },
  ],
  traits: [{ id: trait("taggable"), traits: [] }, { id: trait("orphaned"), traits: [] }],
  fields: [
    scalarField(userOwner, "authId", "upsert"),
    refField(issueOwner, "owner", { _tag: "entity", entity: entity("user") }),
    refField(issueOwner, "parent", { _tag: "self" }),
    refField(userOwner, "parent", { _tag: "self" }),
    scalarField(issueOwner, "title"),
    scalarField(issueOwner, "internalNotes"),
    refField(taggableOwner, "tags", { _tag: "entity", entity: entity("tag") }, "many"),
    refField(tagOwner, "grants", { _tag: "entity", entity: entity("tag-grant") }, "many"),
    refField(grantOwner, "user", { _tag: "entity", entity: entity("user") }),
    refField(grantOwner, "tag", { _tag: "entity", entity: entity("tag") }),
    scalarField(tagOwner, "name"),
  ],
  operations: [
    {
      id: operation(issueOwner, "rename", "required"),
      input: {
        _tag: "struct",
        fields: [
          { key: "title", optional: false, shape: { _tag: "scalar", valueType: "string" } },
          {
            key: "meta",
            optional: true,
            shape: {
              _tag: "struct",
              fields: [{ key: "note", optional: false, shape: { _tag: "scalar", valueType: "string" } }],
            },
          },
        ],
      },
    },
    {
      id: operation(issueOwner, "create", "none"),
      input: {
        _tag: "struct",
        fields: [{ key: "title", optional: false, shape: { _tag: "scalar", valueType: "string" } }],
      },
    },
    {
      id: operation(taggableOwner, "addTag", "required"),
      input: { _tag: "ref", refTarget: { _tag: "entity", entity: entity("tag") } },
    },
    {
      id: operation(taggableOwner, "reindex", "none"),
      input: { _tag: "opaque" },
    },
    {
      id: operation(issueOwner, "slug", "required"),
      input: { _tag: "scalar", valueType: "string" },
    },
    {
      id: operation(issueOwner, "labels", "required"),
      input: { _tag: "array", items: { _tag: "scalar", valueType: "string" } },
    },
    {
      id: operation({ kind: "trait", name: "orphaned" }, "ping", "none"),
      input: { _tag: "opaque" },
    },
    {
      id: operation(issueOwner, "reparentMany", "required"),
      input: { _tag: "array", items: { _tag: "ref", refTarget: { _tag: "self" } } },
    },
    {
      id: operation(userOwner, "reparentMany", "required"),
      input: { _tag: "array", items: { _tag: "ref", refTarget: { _tag: "self" } } },
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

const resourceRef = (...steps: ReadonlyArray<{ field: FieldId }>) =>
  ({ _tag: "ref" as const, root: { _tag: "resource" as const }, steps });

const bindRef = (name: string, ...steps: ReadonlyArray<{ field: FieldId }>) =>
  ({ _tag: "ref" as const, root: { _tag: "bind" as const, name }, steps });

const stamp = (
  focus: CanonicalRuleFocus,
  expr: CanonicalAuthorizationExpr,
  flags: Omit<CanonicalAuthorizationRule, "id" | "focus" | "expr">,
): CanonicalAuthorizationRule => {
  const draft: CanonicalAuthorizationRule = {
    id: RuleId.make(digestHex(0)),
    focus,
    expr,
    ...flags,
  };
  return { ...draft, id: hashCanonicalRuleSync(draft) };
};

const ownsIssue = () =>
  stamp(
    { _tag: "entity", entity: entity("issue") },
    {
      _tag: "eq",
      left: resourceRef(step(issueOwner, "owner")),
      right: { _tag: "me" },
    },
    {
      usesResource: true,
      usesInput: false,
      usesMe: true,
      usesSubject: false,
      traversalDepth: 1,
      existsDepth: 0,
      dependencies: [],
    },
  );

const tagGrant = () =>
  stamp(
    { _tag: "trait", trait: trait("taggable") },
    {
      _tag: "some",
      collection: resourceRef(step(taggableOwner, "tags")),
      bind: "tag",
      pred: {
        _tag: "exists",
        entity: entity("tag-grant"),
        bind: "grant",
        pred: {
          _tag: "and",
          exprs: [
            {
              _tag: "eq",
              left: bindRef("grant", step(grantOwner, "user")),
              right: { _tag: "me" },
            },
            {
              _tag: "eq",
              left: bindRef("grant", step(grantOwner, "tag")),
              right: { _tag: "bind", name: "tag" },
            },
          ],
        },
      },
    },
    {
      usesResource: true,
      usesInput: false,
      usesMe: true,
      usesSubject: false,
      traversalDepth: 1,
      existsDepth: 1,
      dependencies: [],
    },
  );

const nestedTagGrant = () =>
  stamp(
    { _tag: "trait", trait: trait("taggable") },
    {
      _tag: "some",
      collection: resourceRef(step(taggableOwner, "tags"), step(tagOwner, "grants")),
      bind: "grant",
      pred: {
        _tag: "eq",
        left: bindRef("grant", step(grantOwner, "user")),
        right: { _tag: "me" },
      },
    },
    {
      usesResource: true,
      usesInput: false,
      usesMe: true,
      usesSubject: false,
      traversalDepth: 3,
      existsDepth: 0,
      dependencies: [],
    },
  );

const renameInput = () =>
  stamp(
    { _tag: "operation", operation: operation(issueOwner, "rename", "required") },
    {
      _tag: "and",
      exprs: [
        { _tag: "hasClass", class: "member" },
        { _tag: "has", term: { _tag: "input", path: ["title"] } },
        { _tag: "eq", left: { _tag: "subject" }, right: { _tag: "claim", key: "org" } },
      ],
    },
    {
      usesResource: false,
      usesInput: true,
      usesMe: false,
      usesSubject: true,
      traversalDepth: 0,
      existsDepth: 0,
      dependencies: [],
    },
  );

const createInput = () =>
  stamp(
    { _tag: "operation", operation: operation(issueOwner, "create", "none") },
    { _tag: "has", term: { _tag: "input", path: ["title"] } },
    {
      usesResource: false,
      usesInput: true,
      usesMe: false,
      usesSubject: false,
      traversalDepth: 0,
      existsDepth: 0,
      dependencies: [],
    },
  );

const fieldRule = () =>
  stamp(
    { _tag: "field", field: field(issueOwner, "internalNotes") },
    { _tag: "hasClass", class: "member" },
    {
      usesResource: false,
      usesInput: false,
      usesMe: false,
      usesSubject: false,
      traversalDepth: 0,
      existsDepth: 0,
      dependencies: [],
    },
  );

const alwaysTrue = (focus: CanonicalRuleFocus) =>
  stamp(focus, { _tag: "const", value: true }, {
    usesResource: false,
    usesInput: false,
    usesMe: false,
    usesSubject: false,
    traversalDepth: 0,
    existsDepth: 0,
    dependencies: [],
  });

const boundDocument = (
  rules: ReadonlyArray<CanonicalAuthorizationRule>,
  decisions: BoundAuthorizationIR["decisions"] = {
    entities: [],
    traits: [],
    fields: [],
    operations: [],
  },
  extras: Partial<BoundAuthorizationIR> = {},
): BoundAuthorizationIR => ({
  _tag: "BoundAuthorizationIR",
  version: BOUND_AUTHORIZATION_IR_VERSION,
  database,
  catalog,
  catalogVersion: version,
  schemaFingerprint: fingerprint,
  classes: ["member"],
  claims: [{ key: "org", optional: false, shape: { _tag: "scalar", valueType: "string" } }],
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

const validate = (bound: BoundAuthorizationIR, desc: CatalogDescriptor = descriptor) =>
  validateBoundAuthorizationResult({ bound, descriptor: desc });

describe("successful validation", () => {
  test("validates entity, trait, field, targeted, and targetless rules", () => {
    const owns = ownsIssue();
    const tags = tagGrant();
    const notes = fieldRule();
    const rename = renameInput();
    const create = createInput();
    const bound = boundDocument(
      [owns, tags, notes, rename, create],
      {
        entities: [{ target: entity("issue"), decision: { allow: [owns.id], deny: [] } }],
        traits: [{ target: trait("taggable"), decision: { allow: [tags.id], deny: [] } }],
        fields: [
          { target: field(issueOwner, "internalNotes"), decision: { allow: [notes.id], deny: [] } },
        ],
        operations: [
          {
            target: operation(issueOwner, "rename", "required"),
            decision: { allow: [rename.id], deny: [] },
          },
          {
            target: operation(issueOwner, "create", "none"),
            decision: { allow: [create.id], deny: [] },
          },
        ],
      },
    );
    const validated = expectValidated(validate(bound));
    expect(validated._tag).toBe("ValidatedAuthorizationIR");
    expect(validated.version).toBe(VALIDATED_AUTHORIZATION_IR_VERSION);
    expect(Object.isFrozen(validated)).toBe(true);
    expect("policyHash" in validated).toBe(false);
    expect("accessPlans" in validated).toBe(false);
    expect(validated.rules.map((rule) => rule.id)).toEqual([
      owns.id,
      tags.id,
      notes.id,
      rename.id,
      create.id,
    ]);
  });

  test("accepts Taggable -> Tag -> TagGrant nested traversal", () => {
    const nested = nestedTagGrant();
    expectValidated(
      validate(
        boundDocument([nested], {
          entities: [],
          traits: [{ target: trait("taggable"), decision: { allow: [nested.id], deny: [] } }],
          fields: [],
          operations: [],
        }),
      ),
    );
  });

  test("accepts same-entity existential self-joins", () => {
    const selfJoin = stamp(
      { _tag: "entity", entity: entity("issue") },
      {
        _tag: "exists",
        entity: entity("tag-grant"),
        bind: "left",
        pred: {
          _tag: "exists",
          entity: entity("tag-grant"),
          bind: "right",
          pred: {
            _tag: "eq",
            left: bindRef("left", step(grantOwner, "user")),
            right: bindRef("right", step(grantOwner, "user")),
          },
        },
      },
      {
        usesResource: false,
        usesInput: false,
        usesMe: false,
        usesSubject: false,
        traversalDepth: 1,
        existsDepth: 2,
        dependencies: [],
      },
    );
    expectValidated(validate(boundDocument([selfJoin])));
  });

  test("missing me is a runtime completeness concern", () => {
    const owns = ownsIssue();
    const bound = boundDocument([owns], undefined, {
      principal: { subjectClaim: "sub" },
    });
    expectValidated(validate(bound));
  });

  test("trait-focused rule can authorize a composing entity", () => {
    const tags = tagGrant();
    expectValidated(
      validate(
        boundDocument([tags], {
          entities: [{ target: entity("issue"), decision: { allow: [tags.id], deny: [] } }],
          traits: [],
          fields: [],
          operations: [],
        }),
      ),
    );
  });
});

describe("tampered derived metadata", () => {
  const flags = [
    "usesResource",
    "usesInput",
    "usesMe",
    "usesSubject",
    "traversalDepth",
    "existsDepth",
    "dependencies",
  ] as const;

  for (const flag of flags) {
    test(`rejects tampered ${flag}`, () => {
      const rule = ownsIssue();
      const tampered = {
        ...rule,
        ...(flag === "dependencies"
          ? { dependencies: [rule.id] }
          : flag === "traversalDepth" || flag === "existsDepth"
            ? { [flag]: rule[flag] + 1 }
            : { [flag]: !rule[flag] }),
      };
      const pattern =
        flag === "dependencies" ? /named-rule dependencies must be empty/ : new RegExp(`tampered ${flag}`);
      expectFailure(validate(boundDocument([tampered])), "InvalidIR", pattern);
    });
  }

  test("rejects a tampered rule id", () => {
    const rule = { ...ownsIssue(), id: RuleId.make(digestHex(0xab)) };
    expectFailure(validate(boundDocument([rule])), "InvalidIR", /tampered rule id/);
  });
});

describe("traversal", () => {
  test("rejects a field owned by the wrong entity", () => {
    const rule = stamp(
      { _tag: "entity", entity: entity("issue") },
      {
        _tag: "has",
        term: resourceRef(step(userOwner, "authId")),
      },
      {
        usesResource: true,
        usesInput: false,
        usesMe: false,
        usesSubject: false,
        traversalDepth: 1,
        existsDepth: 0,
        dependencies: [],
      },
    );
    expectFailure(validate(boundDocument([rule])), "InvalidIR", /wrong owner/);
  });

  test("rejects a field that does not exist on the owner", () => {
    const rule = stamp(
      { _tag: "entity", entity: entity("issue") },
      {
        _tag: "has",
        term: resourceRef({ field: field(issueOwner, "missing") }),
      },
      {
        usesResource: true,
        usesInput: false,
        usesMe: false,
        usesSubject: false,
        traversalDepth: 1,
        existsDepth: 0,
        dependencies: [],
      },
    );
    expectFailure(validate(boundDocument([rule])), "InvalidIR", /stale identity: missing traversal field/);
  });

  test("rejects traversal through a non-ref field", () => {
    const rule = stamp(
      { _tag: "entity", entity: entity("issue") },
      {
        _tag: "has",
        term: resourceRef(step(issueOwner, "title"), step(userOwner, "authId")),
      },
      {
        usesResource: true,
        usesInput: false,
        usesMe: false,
        usesSubject: false,
        traversalDepth: 2,
        existsDepth: 0,
        dependencies: [],
      },
    );
    expectFailure(validate(boundDocument([rule])), "InvalidIR", /non-ref traversal/);
  });

  test("rejects a hop whose field belongs to the wrong ref target", () => {
    const rule = stamp(
      { _tag: "entity", entity: entity("issue") },
      {
        _tag: "has",
        term: resourceRef(step(issueOwner, "owner"), step(issueOwner, "title")),
      },
      {
        usesResource: true,
        usesInput: false,
        usesMe: false,
        usesSubject: false,
        traversalDepth: 2,
        existsDepth: 0,
        dependencies: [],
      },
    );
    expectFailure(validate(boundDocument([rule])), "InvalidIR", /wrong owner/);
  });

  test("rejects excessive traversal depth", () => {
    const rule = stamp(
      { _tag: "entity", entity: entity("issue") },
      {
        _tag: "has",
        term: resourceRef(
          step(issueOwner, "owner"),
          step(userOwner, "authId"),
          step(userOwner, "authId"),
          step(userOwner, "authId"),
        ),
      },
      {
        usesResource: true,
        usesInput: false,
        usesMe: false,
        usesSubject: false,
        traversalDepth: 4,
        existsDepth: 0,
        dependencies: [],
      },
    );
    expectFailure(validate(boundDocument([rule])), "InvalidIR", /traversal depth 4 exceeds 3/);
  });

  test("resolves self refs relative to their owners", () => {
    const compatible = stamp(
      { _tag: "entity", entity: entity("issue") },
      {
        _tag: "eq",
        left: resourceRef(step(issueOwner, "parent")),
        right: { _tag: "ref", root: { _tag: "resource" }, steps: [] },
      },
      {
        usesResource: true,
        usesInput: false,
        usesMe: false,
        usesSubject: false,
        traversalDepth: 1,
        existsDepth: 0,
        dependencies: [],
      },
    );
    expectValidated(validate(boundDocument([compatible])));
    const mismatched = stamp(
      { _tag: "entity", entity: entity("issue") },
      {
        _tag: "eq",
        left: resourceRef(step(issueOwner, "parent")),
        right: resourceRef(step(issueOwner, "owner"), step(userOwner, "parent")),
      },
      {
        usesResource: true,
        usesInput: false,
        usesMe: false,
        usesSubject: false,
        traversalDepth: 2,
        existsDepth: 0,
        dependencies: [],
      },
    );
    expectFailure(validate(boundDocument([mismatched])), "InvalidIR", /incompatible equality/);
  });

  test("rejects a stale field identity from another catalog", () => {
    const stale = FieldId.make({ catalog: CatalogId.make("other"), owner: issueOwner, localName: "owner" });
    const rule = stamp(
      { _tag: "entity", entity: entity("issue") },
      { _tag: "has", term: { _tag: "ref", root: { _tag: "resource" }, steps: [{ field: stale }] } },
      {
        usesResource: true,
        usesInput: false,
        usesMe: false,
        usesSubject: false,
        traversalDepth: 1,
        existsDepth: 0,
        dependencies: [],
      },
    );
    expectFailure(validate(boundDocument([rule])), "CatalogMismatch", /stale identity: cross-catalog/);
  });
});

describe("named rules and bindings", () => {
  test("rejects a non-empty named-rule dependency", () => {
    const rule = ownsIssue();
    expectFailure(
      validate(boundDocument([{ ...rule, dependencies: [rule.id] }])),
      "InvalidIR",
      /named-rule dependencies must be empty/,
    );
  });

  test("rejects a two-rule dependency list as non-empty", () => {
    const a = ownsIssue();
    const b = fieldRule();
    expectFailure(
      validate(boundDocument([{ ...a, dependencies: [b.id] }, { ...b, dependencies: [a.id] }])),
      "InvalidIR",
      /named-rule dependencies must be empty/,
    );
  });
});

describe("me, claims, and classes", () => {
  test("rejects structurally invalid me equality", () => {
    const rule = stamp(
      { _tag: "entity", entity: entity("issue") },
      { _tag: "eq", left: { _tag: "me" }, right: { _tag: "lit", value: "x" } },
      {
        usesResource: false,
        usesInput: false,
        usesMe: true,
        usesSubject: false,
        traversalDepth: 0,
        existsDepth: 0,
        dependencies: [],
      },
    );
    expectFailure(validate(boundDocument([rule])), "InvalidIR", /incompatible equality/);
  });

  test("rejects me traversal without a principal entity", () => {
    const rule = stamp(
      { _tag: "entity", entity: entity("issue") },
      {
        _tag: "has",
        term: { _tag: "ref", root: { _tag: "me" }, steps: [step(userOwner, "authId")] },
      },
      {
        usesResource: false,
        usesInput: false,
        usesMe: true,
        usesSubject: false,
        traversalDepth: 1,
        existsDepth: 0,
        dependencies: [],
      },
    );
    expectFailure(
      validate(boundDocument([rule], undefined, { principal: { subjectClaim: "sub" } })),
      "InvalidIR",
      /structurally invalid me traversal/,
    );
  });

  test("accepts a declared claim and class", () => {
    expectValidated(validate(boundDocument([renameInput()])));
  });

  test("rejects an undeclared claim", () => {
    const rule = stamp(
      { _tag: "operation", operation: operation(issueOwner, "rename", "required") },
      { _tag: "has", term: { _tag: "claim", key: "teams" } },
      {
        usesResource: false,
        usesInput: false,
        usesMe: false,
        usesSubject: false,
        traversalDepth: 0,
        existsDepth: 0,
        dependencies: [],
      },
    );
    expectFailure(validate(boundDocument([rule])), "InvalidIR", /undeclared claim 'teams'/);
  });

  test("rejects an undeclared class", () => {
    const rule = stamp(
      { _tag: "entity", entity: entity("issue") },
      { _tag: "hasClass", class: "admin" },
      {
        usesResource: false,
        usesInput: false,
        usesMe: false,
        usesSubject: false,
        traversalDepth: 0,
        existsDepth: 0,
        dependencies: [],
      },
    );
    expectFailure(validate(boundDocument([rule])), "InvalidIR", /undeclared class 'admin'/);
  });

  test("rejects a blank principal subject claim", () => {
    expectFailure(
      validate(boundDocument([ownsIssue()], undefined, { principal: { subjectClaim: "" } })),
      "InvalidIR",
      /blank principal subject claim/,
    );
  });

  test("rejects a non-string principal lookup field", () => {
    const longAuthId: CatalogDescriptor = {
      ...descriptor,
      fields: descriptor.fields.map((entry) =>
        entry.id.localName === "authId" ? { ...entry, valueType: "long" as const } : entry,
      ),
    };
    expectFailure(
      validate(boundDocument([ownsIssue()]), longAuthId),
      "InvalidIR",
      /principal field must be string-compatible/,
    );
  });

  test("rejects a ref principal lookup field", () => {
    const refAuthId: CatalogDescriptor = {
      ...descriptor,
      fields: descriptor.fields.map((entry) =>
        entry.id.localName === "authId"
          ? {
              ...entry,
              valueType: "ref" as const,
              refTarget: { _tag: "entity" as const, entity: entity("user") },
            }
          : entry,
      ),
    };
    expectFailure(
      validate(boundDocument([ownsIssue()]), refAuthId),
      "InvalidIR",
      /principal field must be string-compatible/,
    );
  });

  test("accepts a uuid principal lookup field", () => {
    const uuidAuthId: CatalogDescriptor = {
      ...descriptor,
      fields: descriptor.fields.map((entry) =>
        entry.id.localName === "authId" ? { ...entry, valueType: "uuid" as const } : entry,
      ),
    };
    expectValidated(validate(boundDocument([ownsIssue()]), uuidAuthId));
  });

  test("rejects a nested blank claim key", () => {
    expectFailure(
      validate(
        boundDocument([ownsIssue()], undefined, {
          claims: [
            {
              key: "profile",
              optional: false,
              shape: {
                _tag: "struct",
                fields: [{ key: "", optional: false, shape: { _tag: "scalar", valueType: "string" } }],
              },
            },
          ],
        }),
      ),
      "InvalidIR",
      /blank claim key/,
    );
  });

  test("rejects a nested duplicate claim key", () => {
    expectFailure(
      validate(
        boundDocument([ownsIssue()], undefined, {
          claims: [
            {
              key: "profile",
              optional: false,
              shape: {
                _tag: "struct",
                fields: [
                  { key: "org", optional: false, shape: { _tag: "scalar", valueType: "string" } },
                  { key: "org", optional: false, shape: { _tag: "scalar", valueType: "string" } },
                ],
              },
            },
          ],
        }),
      ),
      "InvalidIR",
      /duplicate claim key 'org'/,
    );
  });

  test("rejects a duplicate claim key nested inside an array", () => {
    expectFailure(
      validate(
        boundDocument([ownsIssue()], undefined, {
          claims: [
            {
              key: "teams",
              optional: false,
              shape: {
                _tag: "array",
                items: {
                  _tag: "struct",
                  fields: [
                    { key: "id", optional: false, shape: { _tag: "scalar", valueType: "string" } },
                    { key: "id", optional: false, shape: { _tag: "scalar", valueType: "string" } },
                  ],
                },
              },
            },
          ],
        }),
      ),
      "InvalidIR",
      /duplicate claim key 'id'/,
    );
  });

  test("accepts eq of a trait resource and a composing me", () => {
    const composing: CatalogDescriptor = {
      ...descriptor,
      entities: descriptor.entities.map((row) =>
        row.id.name === "user" ? { ...row, traits: [trait("taggable")] } : row,
      ),
      traitComposition: [
        ...descriptor.traitComposition,
        { composer: entity("user"), trait: trait("taggable"), transitive: [trait("taggable")] },
      ],
    };
    const rule = stamp(
      { _tag: "trait", trait: trait("taggable") },
      {
        _tag: "eq",
        left: { _tag: "ref", root: { _tag: "resource" }, steps: [] },
        right: { _tag: "me" },
      },
      {
        usesResource: true,
        usesInput: false,
        usesMe: true,
        usesSubject: false,
        traversalDepth: 0,
        existsDepth: 0,
        dependencies: [],
      },
    );
    expectValidated(validate(boundDocument([rule]), composing));
  });

  test("accepts eq of a child-trait resource and a parent-trait ref", () => {
    const labeledOwner = { kind: "trait" as const, name: "labeled" };
    const withChild: CatalogDescriptor = {
      ...descriptor,
      traits: [
        { id: trait("taggable"), traits: [] },
        { id: trait("orphaned"), traits: [] },
        { id: trait("labeled"), traits: [trait("taggable")] },
      ],
      operations: [
        ...descriptor.operations,
        {
          id: operation(labeledOwner, "relate", "required"),
          input: { _tag: "ref", refTarget: { _tag: "trait", trait: trait("taggable") } },
        },
      ],
    };
    const rule = stamp(
      { _tag: "operation", operation: operation(labeledOwner, "relate", "required") },
      {
        _tag: "eq",
        left: { _tag: "ref", root: { _tag: "resource" }, steps: [] },
        right: { _tag: "input", path: [] },
      },
      {
        usesResource: true,
        usesInput: true,
        usesMe: false,
        usesSubject: false,
        traversalDepth: 0,
        existsDepth: 0,
        dependencies: [],
      },
    );
    expectValidated(validate(boundDocument([rule]), withChild));
  });

  test("rejects eq of unrelated trait rows", () => {
    const orphanedOwner = { kind: "trait" as const, name: "orphaned" };
    const withOrphanOp: CatalogDescriptor = {
      ...descriptor,
      operations: [
        ...descriptor.operations,
        {
          id: operation(orphanedOwner, "relate", "required"),
          input: { _tag: "ref", refTarget: { _tag: "trait", trait: trait("taggable") } },
        },
      ],
    };
    const rule = stamp(
      { _tag: "operation", operation: operation(orphanedOwner, "relate", "required") },
      {
        _tag: "eq",
        left: { _tag: "ref", root: { _tag: "resource" }, steps: [] },
        right: { _tag: "input", path: [] },
      },
      {
        usesResource: true,
        usesInput: true,
        usesMe: false,
        usesSubject: false,
        traversalDepth: 0,
        existsDepth: 0,
        dependencies: [],
      },
    );
    expectFailure(
      validate(boundDocument([rule]), withOrphanOp),
      "InvalidIR",
      /incompatible equality/,
    );
  });
});

describe("operation input", () => {
  test("accepts scalar, ref, struct, array, and opaque input roots", () => {
    const scalar = stamp(
      { _tag: "operation", operation: operation(issueOwner, "slug", "required") },
      { _tag: "eq", left: { _tag: "input", path: [] }, right: { _tag: "lit", value: "x" } },
      {
        usesResource: false,
        usesInput: true,
        usesMe: false,
        usesSubject: false,
        traversalDepth: 0,
        existsDepth: 0,
        dependencies: [],
      },
    );
    const ref = stamp(
      { _tag: "operation", operation: operation(taggableOwner, "addTag", "required") },
      { _tag: "has", term: { _tag: "input", path: [] } },
      {
        usesResource: false,
        usesInput: true,
        usesMe: false,
        usesSubject: false,
        traversalDepth: 0,
        existsDepth: 0,
        dependencies: [],
      },
    );
    const struct = renameInput();
    const array = stamp(
      { _tag: "operation", operation: operation(issueOwner, "labels", "required") },
      {
        _tag: "in",
        value: { _tag: "lit", value: "bug" },
        collection: { _tag: "input", path: [] },
      },
      {
        usesResource: false,
        usesInput: true,
        usesMe: false,
        usesSubject: false,
        traversalDepth: 0,
        existsDepth: 0,
        dependencies: [],
      },
    );
    const opaque = stamp(
      { _tag: "operation", operation: operation(taggableOwner, "reindex", "none") },
      { _tag: "has", term: { _tag: "input", path: [] } },
      {
        usesResource: false,
        usesInput: true,
        usesMe: false,
        usesSubject: false,
        traversalDepth: 0,
        existsDepth: 0,
        dependencies: [],
      },
    );
    expectValidated(validate(boundDocument([scalar, ref, struct, array, opaque])));
  });

  test("rejects an unknown struct input path", () => {
    const rule = stamp(
      { _tag: "operation", operation: operation(issueOwner, "rename", "required") },
      { _tag: "has", term: { _tag: "input", path: ["missing"] } },
      {
        usesResource: false,
        usesInput: true,
        usesMe: false,
        usesSubject: false,
        traversalDepth: 0,
        existsDepth: 0,
        dependencies: [],
      },
    );
    expectFailure(validate(boundDocument([rule])), "InvalidIR", /unknown operation input path/);
  });

  test("rejects traversing a scalar input", () => {
    const rule = stamp(
      { _tag: "operation", operation: operation(issueOwner, "slug", "required") },
      { _tag: "has", term: { _tag: "input", path: ["x"] } },
      {
        usesResource: false,
        usesInput: true,
        usesMe: false,
        usesSubject: false,
        traversalDepth: 0,
        existsDepth: 0,
        dependencies: [],
      },
    );
    expectFailure(validate(boundDocument([rule])), "InvalidIR", /cannot traverse scalar operation input/);
  });

  test("rejects traversing an array input by key", () => {
    const rule = stamp(
      { _tag: "operation", operation: operation(issueOwner, "labels", "required") },
      { _tag: "has", term: { _tag: "input", path: ["0"] } },
      {
        usesResource: false,
        usesInput: true,
        usesMe: false,
        usesSubject: false,
        traversalDepth: 0,
        existsDepth: 0,
        dependencies: [],
      },
    );
    expectFailure(validate(boundDocument([rule])), "InvalidIR", /cannot traverse operation input array/);
  });

  test("rejects traversing opaque input", () => {
    const rule = stamp(
      { _tag: "operation", operation: operation(taggableOwner, "reindex", "none") },
      { _tag: "has", term: { _tag: "input", path: ["secret"] } },
      {
        usesResource: false,
        usesInput: true,
        usesMe: false,
        usesSubject: false,
        traversalDepth: 0,
        existsDepth: 0,
        dependencies: [],
      },
    );
    expectFailure(validate(boundDocument([rule])), "InvalidIR", /cannot traverse opaque operation input/);
  });

  test("rejects comparing an opaque input", () => {
    const rule = stamp(
      { _tag: "operation", operation: operation(taggableOwner, "reindex", "none") },
      { _tag: "eq", left: { _tag: "input", path: [] }, right: { _tag: "lit", value: "x" } },
      {
        usesResource: false,
        usesInput: true,
        usesMe: false,
        usesSubject: false,
        traversalDepth: 0,
        existsDepth: 0,
        dependencies: [],
      },
    );
    expectFailure(validate(boundDocument([rule])), "InvalidIR", /incompatible equality/);
  });

  test("accepts a nested struct input path", () => {
    const rule = stamp(
      { _tag: "operation", operation: operation(issueOwner, "rename", "required") },
      { _tag: "has", term: { _tag: "input", path: ["meta", "note"] } },
      {
        usesResource: false,
        usesInput: true,
        usesMe: false,
        usesSubject: false,
        traversalDepth: 0,
        existsDepth: 0,
        dependencies: [],
      },
    );
    expectValidated(validate(boundDocument([rule])));
  });

  test("rejects duplicate nested operation input keys", () => {
    const ambiguous: CatalogDescriptor = {
      ...descriptor,
      operations: descriptor.operations.map((row) =>
        row.id.localName === "rename"
          ? {
              ...row,
              input: {
                _tag: "struct",
                fields: [
                  { key: "title", optional: false, shape: { _tag: "scalar", valueType: "string" } },
                  {
                    key: "meta",
                    optional: true,
                    shape: {
                      _tag: "struct",
                      fields: [
                        { key: "note", optional: false, shape: { _tag: "scalar", valueType: "string" } },
                        { key: "note", optional: false, shape: { _tag: "scalar", valueType: "string" } },
                      ],
                    },
                  },
                ],
              },
            }
          : row,
      ),
    };
    expectFailure(validate(boundDocument([renameInput()]), ambiguous), "InvalidIR", /duplicate operation input key 'note'/);
  });

  test("rejects a blank nested operation input key", () => {
    const blank: CatalogDescriptor = {
      ...descriptor,
      operations: descriptor.operations.map((row) =>
        row.id.localName === "rename"
          ? {
              ...row,
              input: {
                _tag: "struct",
                fields: [
                  {
                    key: "meta",
                    optional: true,
                    shape: {
                      _tag: "struct",
                      fields: [{ key: "", optional: false, shape: { _tag: "scalar", valueType: "string" } }],
                    },
                  },
                ],
              },
            }
          : row,
      ),
    };
    expectFailure(validate(boundDocument([alwaysTrue({ _tag: "operation", operation: operation(issueOwner, "rename", "required") })]), blank), "InvalidIR", /blank operation input key/);
  });

  test("accepts membership of a resource in an array of owner-relative Ref.self", () => {
    const rule = stamp(
      { _tag: "operation", operation: operation(issueOwner, "reparentMany", "required") },
      {
        _tag: "in",
        value: { _tag: "ref", root: { _tag: "resource" }, steps: [] },
        collection: { _tag: "input", path: [] },
      },
      {
        usesResource: true,
        usesInput: true,
        usesMe: false,
        usesSubject: false,
        traversalDepth: 0,
        existsDepth: 0,
        dependencies: [],
      },
    );
    expectValidated(validate(boundDocument([rule])));
  });

  test("rejects membership of me in an incompatible array of Ref.self", () => {
    const rule = stamp(
      { _tag: "operation", operation: operation(issueOwner, "reparentMany", "required") },
      {
        _tag: "in",
        value: { _tag: "me" },
        collection: { _tag: "input", path: [] },
      },
      {
        usesResource: false,
        usesInput: true,
        usesMe: true,
        usesSubject: false,
        traversalDepth: 0,
        existsDepth: 0,
        dependencies: [],
      },
    );
    expectFailure(validate(boundDocument([rule])), "InvalidIR", /incompatible membership operands/);
  });

  test("accepts membership of me in a User-owned array of Ref.self", () => {
    const rule = stamp(
      { _tag: "operation", operation: operation(userOwner, "reparentMany", "required") },
      {
        _tag: "in",
        value: { _tag: "me" },
        collection: { _tag: "input", path: [] },
      },
      {
        usesResource: false,
        usesInput: true,
        usesMe: true,
        usesSubject: false,
        traversalDepth: 0,
        existsDepth: 0,
        dependencies: [],
      },
    );
    expectValidated(validate(boundDocument([rule])));
  });
});

describe("catalog trait composition", () => {
  test("rejects extra traits declared in the derived transitive closure", () => {
    const extra: CatalogDescriptor = {
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
      validate(boundDocument([ownsIssue()]), extra),
      "InvalidIR",
      /contradictory trait composition/,
    );
  });

  test("rejects a missing trait in the derived transitive closure", () => {
    const missing: CatalogDescriptor = {
      ...descriptor,
      traits: [
        { id: trait("taggable"), traits: [trait("named")] },
        { id: trait("named"), traits: [] },
        { id: trait("orphaned"), traits: [] },
      ],
      traitComposition: [
        {
          composer: entity("issue"),
          trait: trait("taggable"),
          transitive: [trait("taggable")],
        },
      ],
    };
    expectFailure(
      validate(boundDocument([ownsIssue()]), missing),
      "InvalidIR",
      /contradictory trait composition/,
    );
  });

  test("rejects a composition row for a trait the entity does not compose", () => {
    const invented: CatalogDescriptor = {
      ...descriptor,
      traitComposition: [
        ...descriptor.traitComposition,
        { composer: entity("user"), trait: trait("taggable"), transitive: [trait("taggable")] },
      ],
    };
    expectFailure(
      validate(boundDocument([ownsIssue()]), invented),
      "InvalidIR",
      /does not compose trait 'taggable'/,
    );
  });

  test("rejects a trait composition cycle instead of folding it into the closure", () => {
    const cyclic: CatalogDescriptor = {
      ...descriptor,
      traits: [
        { id: trait("taggable"), traits: [] },
        { id: trait("orphaned"), traits: [] },
        { id: trait("loop-a"), traits: [trait("loop-b")] },
        { id: trait("loop-b"), traits: [trait("loop-a")] },
      ],
    };
    expectFailure(validate(boundDocument([ownsIssue()]), cyclic), "InvalidIR", /trait composition cycle/);
  });

  test("rejects a missing compiled composition row for a direct entity trait", () => {
    const missingRow: CatalogDescriptor = {
      ...descriptor,
      traitComposition: [],
    };
    expectFailure(
      validate(boundDocument([ownsIssue()]), missingRow),
      "InvalidIR",
      /missing trait composition for 'issue'\/'taggable'/,
    );
  });

  test("accepts a diamond trait composition without treating it as a cycle", () => {
    const diamond: CatalogDescriptor = {
      ...descriptor,
      entities: [
        { id: entity("user"), traits: [] },
        { id: entity("issue"), traits: [trait("taggable"), trait("diamond")] },
        { id: entity("tag"), traits: [] },
        { id: entity("tag-grant"), traits: [] },
      ],
      traits: [
        { id: trait("taggable"), traits: [] },
        { id: trait("orphaned"), traits: [] },
        { id: trait("left"), traits: [trait("shared")] },
        { id: trait("right"), traits: [trait("shared")] },
        { id: trait("shared"), traits: [] },
        { id: trait("diamond"), traits: [trait("left"), trait("right")] },
      ],
      traitComposition: [
        {
          composer: entity("issue"),
          trait: trait("taggable"),
          transitive: [trait("taggable")],
        },
        {
          composer: entity("issue"),
          trait: trait("diamond"),
          transitive: [trait("diamond"), trait("left"), trait("right"), trait("shared")],
        },
      ],
    };
    expectValidated(validate(boundDocument([ownsIssue()]), diamond));
  });
});

describe("targeted and targetless operations", () => {
  test("rejects resource use on a targetless operation-focused rule", () => {
    const rule = stamp(
      { _tag: "operation", operation: operation(issueOwner, "create", "none") },
      { _tag: "has", term: resourceRef(step(issueOwner, "title")) },
      {
        usesResource: true,
        usesInput: false,
        usesMe: false,
        usesSubject: false,
        traversalDepth: 1,
        existsDepth: 0,
        dependencies: [],
      },
    );
    expectFailure(
      validate(boundDocument([rule])),
      "InvalidIR",
      /resource is not available|resource-dependent rule cannot authorize a targetless/,
    );
  });

  test("rejects a resource-dependent entity rule on a targetless operation decision", () => {
    const owns = ownsIssue();
    expectFailure(
      validate(
        boundDocument([owns], {
          entities: [],
          traits: [],
          fields: [],
          operations: [
            {
              target: operation(issueOwner, "create", "none"),
              decision: { allow: [owns.id], deny: [] },
            },
          ],
        }),
      ),
      "InvalidIR",
      /resource-dependent rule cannot authorize a targetless operation/,
    );
  });

  test("rejects a targetless operation on an unreachable trait", () => {
    const rule = alwaysTrue({
      _tag: "operation",
      operation: operation({ kind: "trait", name: "orphaned" }, "ping", "none"),
    });
    expectFailure(validate(boundDocument([rule])), "InvalidIR", /not reachable/);
  });

  test("rejects an unreachable targetless trait operation for a trait-focused rule", () => {
    const rule = alwaysTrue({ _tag: "trait", trait: trait("orphaned") });
    expectFailure(
      validate(
        boundDocument([rule], {
          entities: [],
          traits: [],
          fields: [],
          operations: [
            {
              target: operation({ kind: "trait", name: "orphaned" }, "ping", "none"),
              decision: { allow: [rule.id], deny: [] },
            },
          ],
        }),
      ),
      "InvalidIR",
      /not reachable/,
    );
  });

  test("rejects a targetless operation whose entity owner is missing", () => {
    const ghost = { kind: "entity" as const, name: "ghost" };
    const missingOwner: CatalogDescriptor = {
      ...descriptor,
      operations: [
        ...descriptor.operations,
        { id: operation(ghost, "ping", "none"), input: { _tag: "opaque" } },
      ],
    };
    expectFailure(
      validate(boundDocument([ownsIssue()]), missingOwner),
      "InvalidIR",
      /missing operation owner entity 'ghost'/,
    );
  });
});

describe("decision and focus compatibility", () => {
  test("rejects an unknown decision target", () => {
    const owns = ownsIssue();
    expectFailure(
      validate(
        boundDocument([owns], {
          entities: [{ target: entity("missing"), decision: { allow: [owns.id], deny: [] } }],
          traits: [],
          fields: [],
          operations: [],
        }),
      ),
      "InvalidIR",
      /stale identity: missing entity decision target/,
    );
  });

  test("rejects an unknown rule reference", () => {
    expectFailure(
      validate(
        boundDocument([ownsIssue()], {
          entities: [
            { target: entity("issue"), decision: { allow: [RuleId.make(digestHex(0xee))], deny: [] } },
          ],
          traits: [],
          fields: [],
          operations: [],
        }),
      ),
      "InvalidIR",
      /unknown rule/,
    );
  });

  test("rejects a duplicate decision target", () => {
    const owns = ownsIssue();
    expectFailure(
      validate(
        boundDocument([owns], {
          entities: [
            { target: entity("issue"), decision: { allow: [owns.id], deny: [] } },
            { target: entity("issue"), decision: { allow: [owns.id], deny: [] } },
          ],
          traits: [],
          fields: [],
          operations: [],
        }),
      ),
      "InvalidIR",
      /duplicate entity decision target/,
    );
  });

  test("rejects a contradictory allow and deny", () => {
    const owns = ownsIssue();
    expectFailure(
      validate(
        boundDocument([owns], {
          entities: [{ target: entity("issue"), decision: { allow: [owns.id], deny: [owns.id] } }],
          traits: [],
          fields: [],
          operations: [],
        }),
      ),
      "InvalidIR",
      /contradictory allow and deny/,
    );
  });

  test("rejects an entity rule on a trait decision", () => {
    const owns = ownsIssue();
    expectFailure(
      validate(
        boundDocument([owns], {
          entities: [],
          traits: [{ target: trait("taggable"), decision: { allow: [owns.id], deny: [] } }],
          fields: [],
          operations: [],
        }),
      ),
      "InvalidIR",
      /incompatible with trait decision/,
    );
  });

  test("rejects a field rule on an entity decision", () => {
    const notes = fieldRule();
    expectFailure(
      validate(
        boundDocument([notes], {
          entities: [{ target: entity("issue"), decision: { allow: [notes.id], deny: [] } }],
          traits: [],
          fields: [],
          operations: [],
        }),
      ),
      "InvalidIR",
      /incompatible with entity decision/,
    );
  });

  test("accepts an entity rule on a field of that entity", () => {
    const owns = ownsIssue();
    expectValidated(
      validate(
        boundDocument([owns], {
          entities: [],
          traits: [],
          fields: [
            { target: field(issueOwner, "internalNotes"), decision: { allow: [owns.id], deny: [] } },
          ],
          operations: [],
        }),
      ),
    );
  });

  test("rejects an entity-focused rule on a trait-owned field", () => {
    const owns = ownsIssue();
    expectFailure(
      validate(
        boundDocument([owns], {
          entities: [],
          traits: [],
          fields: [{ target: field(taggableOwner, "tags"), decision: { allow: [owns.id], deny: [] } }],
          operations: [],
        }),
      ),
      "InvalidIR",
      /incompatible with field decision/,
    );
  });

  test("rejects a subtrait-focused rule on a parent trait field", () => {
    const withSubtrait: CatalogDescriptor = {
      ...descriptor,
      traits: [
        { id: trait("taggable"), traits: [] },
        { id: trait("orphaned"), traits: [] },
        { id: trait("labeled"), traits: [trait("taggable")] },
      ],
    };
    const rule = alwaysTrue({ _tag: "trait", trait: trait("labeled") });
    expectFailure(
      validate(
        boundDocument(
          [rule],
          {
            entities: [],
            traits: [],
            fields: [{ target: field(taggableOwner, "tags"), decision: { allow: [rule.id], deny: [] } }],
            operations: [],
          },
        ),
        withSubtrait,
      ),
      "InvalidIR",
      /incompatible with field decision/,
    );
  });

  test("accepts a trait-focused rule on that trait's field", () => {
    const tags = tagGrant();
    expectValidated(
      validate(
        boundDocument([tags], {
          entities: [],
          traits: [],
          fields: [{ target: field(taggableOwner, "tags"), decision: { allow: [tags.id], deny: [] } }],
          operations: [],
        }),
      ),
    );
  });

  test("accepts a trait-focused rule on a composing entity field", () => {
    const tags = tagGrant();
    expectValidated(
      validate(
        boundDocument([tags], {
          entities: [],
          traits: [],
          fields: [
            { target: field(issueOwner, "internalNotes"), decision: { allow: [tags.id], deny: [] } },
          ],
          operations: [],
        }),
      ),
    );
  });

  test("missing decisions remain valid (deny by downstream semantics)", () => {
    expectValidated(validate(boundDocument([ownsIssue()])));
  });
});

describe("bounds", () => {
  test("accepts traversal depth at the limit", () => {
    const rule = stamp(
      { _tag: "trait", trait: trait("taggable") },
      {
        _tag: "has",
        term: resourceRef(step(taggableOwner, "tags"), step(tagOwner, "grants"), step(grantOwner, "user")),
      },
      {
        usesResource: true,
        usesInput: false,
        usesMe: false,
        usesSubject: false,
        traversalDepth: 3,
        existsDepth: 0,
        dependencies: [],
      },
    );
    expectValidated(validate(boundDocument([rule])));
  });

  test("accepts exists depth at the limit and rejects one more", () => {
    const atLimit = stamp(
      { _tag: "entity", entity: entity("issue") },
      {
        _tag: "exists",
        entity: entity("tag-grant"),
        bind: "a",
        pred: {
          _tag: "exists",
          entity: entity("tag-grant"),
          bind: "b",
          pred: {
            _tag: "exists",
            entity: entity("tag-grant"),
            bind: "c",
            pred: { _tag: "const", value: true },
          },
        },
      },
      {
        usesResource: false,
        usesInput: false,
        usesMe: false,
        usesSubject: false,
        traversalDepth: 0,
        existsDepth: 3,
        dependencies: [],
      },
    );
    expectValidated(validate(boundDocument([atLimit])));
    const over = stamp(
      { _tag: "entity", entity: entity("issue") },
      {
        _tag: "exists",
        entity: entity("tag-grant"),
        bind: "a",
        pred: {
          _tag: "exists",
          entity: entity("tag-grant"),
          bind: "b",
          pred: {
            _tag: "exists",
            entity: entity("tag-grant"),
            bind: "c",
            pred: {
              _tag: "exists",
              entity: entity("tag-grant"),
              bind: "d",
              pred: { _tag: "const", value: true },
            },
          },
        },
      },
      {
        usesResource: false,
        usesInput: false,
        usesMe: false,
        usesSubject: false,
        traversalDepth: 0,
        existsDepth: 4,
        dependencies: [],
      },
    );
    expectFailure(validate(boundDocument([over])), "InvalidIR", /exists depth 4 exceeds 3/);
  });

  test("rejects a static work budget overflow", () => {
    const owns = ownsIssue();
    expectFailure(
      validateBoundAuthorizationResultForTest(
        { bound: boundDocument([owns]), descriptor },
        {
          maxTraversalDepth: 3,
          maxExistsDepth: 3,
          maxDependencies: 0,
          maxStaticWork: 1,
        },
      ),
      "InvalidIR",
      /static work .* exceeds 1/,
    );
  });

  test("rejects non-finite test limit overrides", () => {
    const input = { bound: boundDocument([ownsIssue()]), descriptor };
    expectFailure(
      validateBoundAuthorizationResultForTest(input, { maxTraversalDepth: Number.POSITIVE_INFINITY }),
      "InvalidIR",
      /invalid maxTraversalDepth/,
    );
    expectFailure(
      validateBoundAuthorizationResultForTest(input, { maxExistsDepth: Number.NaN }),
      "InvalidIR",
      /invalid maxExistsDepth/,
    );
    expectFailure(
      validateBoundAuthorizationResultForTest(input, { maxStaticWork: -1 }),
      "InvalidIR",
      /invalid maxStaticWork/,
    );
  });

  test("clamps test overrides so callers cannot widen hard limits", () => {
    const over = stamp(
      { _tag: "trait", trait: trait("taggable") },
      {
        _tag: "has",
        term: resourceRef(
          step(taggableOwner, "tags"),
          step(tagOwner, "grants"),
          step(grantOwner, "user"),
          step(userOwner, "authId"),
        ),
      },
      {
        usesResource: true,
        usesInput: false,
        usesMe: false,
        usesSubject: false,
        traversalDepth: 4,
        existsDepth: 0,
        dependencies: [],
      },
    );
    expectFailure(
      validateBoundAuthorizationResultForTest(
        { bound: boundDocument([over]), descriptor },
        { maxTraversalDepth: 100 },
      ),
      "InvalidIR",
      /traversal depth 4 exceeds 3/,
    );
    expect(validateBoundAuthorizationResult.length).toBe(1);
    const widened = (
      validateBoundAuthorizationResult as (
        input: { bound: BoundAuthorizationIR; descriptor: CatalogDescriptor },
        limits?: { maxStaticWork: number },
      ) => ReturnType<typeof validateBoundAuthorizationResult>
    )({ bound: boundDocument([ownsIssue()]), descriptor }, { maxStaticWork: Number.POSITIVE_INFINITY });
    expectValidated(widened);
  });

  test("zero named-rule dependencies is the boundary", () => {
    const owns = ownsIssue();
    expect(owns.dependencies).toEqual([]);
    expectValidated(validate(boundDocument([owns])));
  });

  test("accumulates traversal depth across some bindings", () => {
    const rule = stamp(
      { _tag: "trait", trait: trait("taggable") },
      {
        _tag: "some",
        collection: resourceRef(step(taggableOwner, "tags")),
        bind: "tag",
        pred: {
          _tag: "has",
          term: bindRef("tag", step(tagOwner, "grants"), step(grantOwner, "user"), step(userOwner, "authId")),
        },
      },
      {
        usesResource: true,
        usesInput: false,
        usesMe: false,
        usesSubject: false,
        traversalDepth: 4,
        existsDepth: 0,
        dependencies: [],
      },
    );
    expectFailure(validate(boundDocument([rule])), "InvalidIR", /traversal depth 4 exceeds 3/);
  });

  test("rejects some over a cardinality-one ref", () => {
    const rule = stamp(
      { _tag: "entity", entity: entity("issue") },
      {
        _tag: "some",
        collection: resourceRef(step(issueOwner, "owner")),
        bind: "user",
        pred: { _tag: "const", value: true },
      },
      {
        usesResource: true,
        usesInput: false,
        usesMe: false,
        usesSubject: false,
        traversalDepth: 1,
        existsDepth: 0,
        dependencies: [],
      },
    );
    expectFailure(validate(boundDocument([rule])), "InvalidIR", /some requires a many-valued ref collection/);
  });
});

describe("determinism and hashing", () => {
  test("sync rule hashes match the #357 Effect contract", async () => {
    const rule = ownsIssue();
    const asyncHash = await Effect.runPromise(hashCanonicalRule(rule));
    expect(hashCanonicalRuleSync(rule)).toBe(asyncHash);
  });

  test("sha256HexSync matches known vectors", () => {
    const utf8 = new TextEncoder();
    expect(sha256HexSync(utf8.encode(""))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sha256HexSync(utf8.encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  test("recomputed ids are stable across object key insertion order", () => {
    const owns = ownsIssue();
    const a = boundDocument([owns]);
    const b = {
      schemaFingerprint: fingerprint,
      catalogVersion: version,
      catalog,
      database,
      version: BOUND_AUTHORIZATION_IR_VERSION,
      _tag: "BoundAuthorizationIR" as const,
      principal: { entity: field(userOwner, "authId"), subjectClaim: "sub" as const },
      claims: [{ shape: { valueType: "string" as const, _tag: "scalar" as const }, optional: false, key: "org" }],
      classes: ["member"],
      decisions: a.decisions,
      rules: [owns],
    } satisfies BoundAuthorizationIR;
    const left = expectValidated(validate(a));
    const right = expectValidated(validate(b));
    expect(left.rules[0]?.id).toBe(right.rules[0]?.id);
  });

  test("encode/decode of validated IR preserves recomputed ids", () => {
    const owns = ownsIssue();
    const validated = expectValidated(validate(boundDocument([owns])));
    const encodedDoc = JSON.parse(JSON.stringify(validated)) as ValidatedAuthorizationIR;
    const rebound: BoundAuthorizationIR = {
      ...encodedDoc,
      _tag: "BoundAuthorizationIR",
      version: BOUND_AUTHORIZATION_IR_VERSION,
    };
    const again = expectValidated(validate(rebound));
    expect(again.rules[0]?.id).toBe(validated.rules[0]?.id);
  });
});

describe("purity", () => {
  test("expression traversal does not perform Effect or service lookup", () => {
    let resolves = 0;
    const service = {
      resolve: () => {
        resolves += 1;
        return Effect.succeed(descriptor);
      },
    };
    const result = validateBoundAuthorizationResult({
      bound: boundDocument([ownsIssue()]),
      descriptor,
    });
    expectValidated(result);
    expect(resolves).toBe(0);
    expect(Result.isSuccess(result)).toBe(true);
    void service;
    expect(validateBoundAuthorizationResult.length).toBeGreaterThan(0);
  });

  test("validateBoundAuthorization surfaces InvalidIR on the failure channel", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        validateBoundAuthorization({
          bound: boundDocument([{ ...ownsIssue(), id: RuleId.make(digestHex(0xab)) }]),
          descriptor,
        }),
      ),
    );
    expect(failure).toBeInstanceOf(InvalidIR);
    expect(failure.message).toMatch(/tampered rule id/);
  });

  test("validateBoundAuthorization surfaces CatalogMismatch on the failure channel", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        validateBoundAuthorization({
          bound: boundDocument([ownsIssue()], undefined, {
            catalogVersion: CatalogVersion.make("9"),
          }),
          descriptor,
        }),
      ),
    );
    expect(failure).toBeInstanceOf(CatalogMismatch);
    expect(failure.message).toMatch(/stale catalog version/);
  });

  test("AuthoritativeCatalog is not consulted by the kernel", async () => {
    let resolves = 0;
    const service = {
      resolve: () => {
        resolves += 1;
        return Effect.succeed(descriptor);
      },
    };
    const validated = await Effect.runPromise(
      validateBoundAuthorization({ bound: boundDocument([ownsIssue()]), descriptor }).pipe(
        Effect.provideService(AuthoritativeCatalog, service),
      ),
    );
    expect(validated._tag).toBe("ValidatedAuthorizationIR");
    expect(resolves).toBe(0);
  });
});

describe("type distinction", () => {
  test("validated IR is not installed IR", () => {
    const validated = expectValidated(validate(boundDocument([ownsIssue()])));
    // @ts-expect-error — validated intermediate is not installed IR
    requireInstalled(validated);
    expect(validated._tag).toBe("ValidatedAuthorizationIR");
  });
});

describe("bind then validate", () => {
  test("a correctly flagged bound template validates after restamping", () => {
    const relative = bindPolicyTemplateResult({
      target,
      descriptor,
      template: {
        _tag: "PolicyTemplateIR",
        version: 1,
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
            usesInput: false,
            usesMe: true,
            usesSubject: false,
            traversalDepth: 1,
            existsDepth: 0,
            dependencies: [],
          },
        ],
        decisions: { entities: [], traits: [], fields: [], operations: [] },
      },
    });
    expect(Result.isSuccess(relative)).toBe(true);
    if (Result.isFailure(relative)) throw relative.failure;
    const stamped = stamp(relative.success.rules[0]!.focus, relative.success.rules[0]!.expr, {
      usesResource: true,
      usesInput: false,
      usesMe: true,
      usesSubject: false,
      traversalDepth: 1,
      existsDepth: 0,
      dependencies: [],
    });
    expectValidated(validate({ ...relative.success, rules: [stamped] }));
  });
});
