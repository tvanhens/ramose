/**
 * Catalog-binding kernel tests.
 *
 * Structural decode is out of scope. Semantic expression validation,
 * hash recomputation, and installed-IR assembly are later slices.
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
  INSTALLED_AUTHORIZATION_IR_VERSION,
  InvalidIR,
  OperationId,
  POLICY_TEMPLATE_IR_VERSION,
  PolicyTemplateIR,
  RelativeFieldId,
  RelativeOperationId,
  RuleId,
  SchemaFingerprint,
  TraitId,
  bindAgainstAuthoritativeCatalog,
  bindPolicyTemplate,
  bindPolicyTemplateResult,
  decodeInstalledAuthorizationResult,
  type BoundAuthorizationIR as BoundAuthorizationIRType,
  type CanonicalRuleFocus,
  type CatalogBindingInput,
  type CatalogBindingTarget,
  type CatalogDescriptor,
  type FieldRefTarget,
  type InstalledAuthorizationIR,
  type OwnerRef,
  type RelativeAuthorizationExpr,
} from "../../../src/internal/authorization/index.ts";
import {
  RULE_OWNS_ISSUE,
  RULE_RENAME_INPUT,
  RULE_TAG_GRANT,
  digestHex,
} from "./fixtures.ts";

const RULE_FIELD = digestHex(0xaa);
const RULE_CREATE = digestHex(0xbb);
const RULE_ADD_TAG = digestHex(0xcc);
const RULE_REINDEX = digestHex(0xdd);

const catalog = CatalogId.make("app");
const database = DatabaseId.make("todos");
const version = CatalogVersion.make("1");
const fingerprint = SchemaFingerprint.make("schema");

const issueOwner = { kind: "entity" as const, name: "issue" };
const userOwner = { kind: "entity" as const, name: "user" };
const grantOwner = { kind: "entity" as const, name: "tag-grant" };
const taggableOwner = { kind: "trait" as const, name: "taggable" };

const target: CatalogBindingTarget = {
  database,
  catalog,
  catalogVersion: version,
  schemaFingerprint: fingerprint,
};

const entity = (name: string) => EntityId.make({ catalog, name });
const trait = (name: string) => TraitId.make({ catalog, name });
const field = (owner: OwnerRef, localName: string) =>
  FieldId.make({ catalog, owner, localName });
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
  traits: [{ id: trait("taggable"), traits: [] }],
  fields: [
    scalarField(userOwner, "authId", "upsert"),
    refField(issueOwner, "owner", { _tag: "entity", entity: entity("user") }),
    scalarField(issueOwner, "title"),
    scalarField(issueOwner, "internalNotes"),
    refField(taggableOwner, "tags", { _tag: "entity", entity: entity("tag") }, "many"),
    refField(grantOwner, "user", { _tag: "entity", entity: entity("user") }),
    refField(grantOwner, "tag", { _tag: "entity", entity: entity("tag") }),
    scalarField({ kind: "entity", name: "tag" }, "name"),
  ],
  operations: [
    {
      id: operation(issueOwner, "rename", "required"),
      input: {
        _tag: "struct",
        fields: [
          {
            key: "title",
            optional: false,
            shape: { _tag: "scalar", valueType: "string" },
          },
        ],
      },
    },
    {
      id: operation(issueOwner, "create", "none"),
      input: {
        _tag: "struct",
        fields: [
          {
            key: "title",
            optional: false,
            shape: { _tag: "scalar", valueType: "string" },
          },
        ],
      },
    },
    {
      id: operation(taggableOwner, "addTag", "required"),
      input: {
        _tag: "ref",
        refTarget: { _tag: "entity", entity: entity("tag") },
      },
    },
    {
      id: operation(taggableOwner, "reindex", "none"),
      input: { _tag: "opaque" },
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

const relativeField = (owner: OwnerRef, localName: string) =>
  RelativeFieldId.make({ owner, localName });

const relativeOperation = (
  owner: OwnerRef,
  localName: string,
  operationTarget: "required" | "none",
) => RelativeOperationId.make({ owner, localName, target: operationTarget });

const rule = (
  id: string,
  focus: PolicyTemplateIR["rules"][number]["focus"],
  expr: RelativeAuthorizationExpr,
): PolicyTemplateIR["rules"][number] => ({
  id: RuleId.make(id),
  focus,
  expr,
  usesResource: true,
  usesInput: false,
  usesMe: true,
  usesSubject: false,
  traversalDepth: 1,
  existsDepth: 0,
  dependencies: [],
});

const fullTemplate = (): PolicyTemplateIR => ({
  _tag: "PolicyTemplateIR",
  version: POLICY_TEMPLATE_IR_VERSION,
  classes: ["member"],
  claims: [
    {
      key: "org",
      optional: false,
      shape: { _tag: "scalar", valueType: "string" },
    },
  ],
  principal: {
    subjectClaim: "sub",
    entity: relativeField(userOwner, "authId"),
  },
  rules: [
    rule(RULE_OWNS_ISSUE, { _tag: "entity", entity: { _tag: "RelativeEntityId", name: "issue" } }, {
      _tag: "eq",
      left: {
        _tag: "ref",
        root: { _tag: "resource" },
        steps: [{ field: relativeField(issueOwner, "owner") }],
      },
      right: { _tag: "me" },
    }),
    {
      ...rule(
        RULE_RENAME_INPUT,
        { _tag: "operation", operation: relativeOperation(issueOwner, "rename", "required") },
        {
          _tag: "and",
          exprs: [
            { _tag: "hasClass", class: "member" },
            { _tag: "has", term: { _tag: "input", path: ["title"] } },
            { _tag: "eq", left: { _tag: "subject" }, right: { _tag: "claim", key: "org" } },
            {
              _tag: "in",
              value: { _tag: "lit", value: "x" },
              collection: {
                _tag: "ref",
                root: { _tag: "resource" },
                steps: [{ field: relativeField(issueOwner, "title") }],
              },
            },
          ],
        },
      ),
      usesResource: false,
      usesInput: true,
      usesMe: false,
      usesSubject: true,
      traversalDepth: 0,
    },
    {
      ...rule(
        RULE_TAG_GRANT,
        { _tag: "trait", trait: { _tag: "RelativeTraitId", name: "taggable" } },
        {
          _tag: "some",
          collection: {
            _tag: "ref",
            root: { _tag: "resource" },
            steps: [{ field: relativeField(taggableOwner, "tags") }],
          },
          bind: "tag",
          pred: {
            _tag: "exists",
            entity: { _tag: "RelativeEntityId", name: "tag-grant" },
            bind: "grant",
            pred: {
              _tag: "and",
              exprs: [
                {
                  _tag: "eq",
                  left: {
                    _tag: "ref",
                    root: { _tag: "bind", name: "grant" },
                    steps: [{ field: relativeField(grantOwner, "user") }],
                  },
                  right: { _tag: "me" },
                },
                {
                  _tag: "eq",
                  left: {
                    _tag: "ref",
                    root: { _tag: "bind", name: "grant" },
                    steps: [{ field: relativeField(grantOwner, "tag") }],
                  },
                  right: { _tag: "bind", name: "tag" },
                },
                {
                  _tag: "overlaps",
                  left: {
                    _tag: "ref",
                    root: { _tag: "resource" },
                    steps: [{ field: relativeField(taggableOwner, "tags") }],
                  },
                  right: {
                    _tag: "ref",
                    root: { _tag: "bind", name: "grant" },
                    steps: [{ field: relativeField(grantOwner, "tag") }],
                  },
                },
              ],
            },
          },
        },
      ),
      existsDepth: 1,
    },
    rule(
      RULE_FIELD,
      { _tag: "field", field: relativeField(issueOwner, "internalNotes") },
      { _tag: "const", value: true },
    ),
    rule(
      RULE_CREATE,
      { _tag: "operation", operation: relativeOperation(issueOwner, "create", "none") },
      { _tag: "has", term: { _tag: "input", path: [] } },
    ),
    rule(
      RULE_ADD_TAG,
      { _tag: "operation", operation: relativeOperation(taggableOwner, "addTag", "required") },
      { _tag: "has", term: { _tag: "input", path: [] } },
    ),
    rule(
      RULE_REINDEX,
      { _tag: "operation", operation: relativeOperation(taggableOwner, "reindex", "none") },
      { _tag: "const", value: true },
    ),
  ],
  decisions: {
    entities: [
      {
        target: { _tag: "RelativeEntityId", name: "issue" },
        decision: { allow: [RuleId.make(RULE_OWNS_ISSUE)], deny: [] },
      },
    ],
    traits: [
      {
        target: { _tag: "RelativeTraitId", name: "taggable" },
        decision: { allow: [RuleId.make(RULE_TAG_GRANT)], deny: [] },
      },
    ],
    fields: [
      {
        target: relativeField(issueOwner, "internalNotes"),
        decision: { allow: [RuleId.make(RULE_FIELD)], deny: [] },
      },
    ],
    operations: [
      {
        target: relativeOperation(issueOwner, "rename", "required"),
        decision: { allow: [RuleId.make(RULE_RENAME_INPUT)], deny: [] },
      },
      {
        target: relativeOperation(issueOwner, "create", "none"),
        decision: { allow: [RuleId.make(RULE_CREATE)], deny: [] },
      },
      {
        target: relativeOperation(taggableOwner, "addTag", "required"),
        decision: { allow: [RuleId.make(RULE_ADD_TAG)], deny: [] },
      },
      {
        target: relativeOperation(taggableOwner, "reindex", "none"),
        decision: { allow: [RuleId.make(RULE_REINDEX)], deny: [] },
      },
    ],
  },
});

const bindingInput = (
  overrides: Partial<CatalogBindingInput> = {},
): CatalogBindingInput => ({
  target,
  descriptor: catalogDescriptor(),
  template: fullTemplate(),
  ...overrides,
});

const expectBound = (result: Result.Result<BoundAuthorizationIRType, InvalidIR | CatalogMismatch>) => {
  expect(Result.isSuccess(result)).toBe(true);
  if (Result.isFailure(result)) throw result.failure;
  return result.success;
};

const findRule = (
  bound: BoundAuthorizationIRType,
  match: (focus: CanonicalRuleFocus) => boolean,
) => {
  const found = bound.rules.find((entry) => match(entry.focus));
  if (found === undefined) throw new Error("expected bound rule");
  return found;
};

const entityRule = (bound: BoundAuthorizationIRType, name: string) =>
  findRule(bound, (focus) => focus._tag === "entity" && focus.entity.name === name);

const traitRule = (bound: BoundAuthorizationIRType, name: string) =>
  findRule(bound, (focus) => focus._tag === "trait" && focus.trait.name === name);

const fieldRule = (bound: BoundAuthorizationIRType, owner: OwnerRef, localName: string) =>
  findRule(
    bound,
    (focus) =>
      focus._tag === "field" &&
      focus.field.owner.name === owner.name &&
      focus.field.localName === localName,
  );

const operationRule = (
  bound: BoundAuthorizationIRType,
  owner: OwnerRef,
  localName: string,
  operationTarget: "required" | "none",
) =>
  findRule(
    bound,
    (focus) =>
      focus._tag === "operation" &&
      focus.operation.owner.name === owner.name &&
      focus.operation.localName === localName &&
      focus.operation.target === operationTarget,
  );

const expectFailure = (
  result: Result.Result<unknown, InvalidIR | CatalogMismatch>,
  tag: "InvalidIR" | "CatalogMismatch",
  pattern: RegExp,
) => {
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isSuccess(result)) throw new Error("expected bind failure");
  expect(result.failure._tag).toBe(tag);
  expect(result.failure.message).toMatch(pattern);
  expect(result.failure._tag).not.toBe("AuthorizationDenied");
};

const requireInstalled = (_ir: InstalledAuthorizationIR): void => undefined;

describe("successful binding", () => {
  test("binds every identity kind in every identity-bearing IR position", () => {
    const bound = expectBound(bindPolicyTemplateResult(bindingInput()));

    expect(bound._tag).toBe("BoundAuthorizationIR");
    expect(bound.version).toBe(BOUND_AUTHORIZATION_IR_VERSION);
    expect(bound.database).toBe(database);
    expect(bound.catalog).toBe(catalog);
    expect(bound.catalogVersion).toBe(version);
    expect(bound.schemaFingerprint).toBe(fingerprint);
    expect(Object.getPrototypeOf(bound)).toBe(Object.prototype);
    expect(Object.isFrozen(bound)).toBe(true);
    expect("policyHash" in bound).toBe(false);
    expect("accessPlans" in bound).toBe(false);
    expect("identities" in bound).toBe(false);
    expect("operations" in bound).toBe(false);
    expect("traitComposition" in bound).toBe(false);

    expect(bound.principal.entity).toEqual(field(userOwner, "authId"));

    expect(entityRule(bound, "issue").focus).toEqual({ _tag: "entity", entity: entity("issue") });
    expect(traitRule(bound, "taggable").focus).toEqual({ _tag: "trait", trait: trait("taggable") });
    expect(fieldRule(bound, issueOwner, "internalNotes").focus).toEqual({
      _tag: "field",
      field: field(issueOwner, "internalNotes"),
    });
    expect(operationRule(bound, issueOwner, "rename", "required").focus).toEqual({
      _tag: "operation",
      operation: operation(issueOwner, "rename", "required"),
    });
    expect(operationRule(bound, issueOwner, "create", "none").focus).toEqual({
      _tag: "operation",
      operation: operation(issueOwner, "create", "none"),
    });
    expect(operationRule(bound, taggableOwner, "addTag", "required").focus).toEqual({
      _tag: "operation",
      operation: operation(taggableOwner, "addTag", "required"),
    });
    expect(operationRule(bound, taggableOwner, "reindex", "none").focus).toEqual({
      _tag: "operation",
      operation: operation(taggableOwner, "reindex", "none"),
    });

    const owns = entityRule(bound, "issue");
    expect(owns.expr).toEqual({
      _tag: "eq",
      left: {
        _tag: "ref",
        root: { _tag: "resource" },
        steps: [{ field: field(issueOwner, "owner") }],
      },
      right: { _tag: "me" },
    });

    const tagGrant = traitRule(bound, "taggable");
    expect(tagGrant.expr._tag).toBe("some");
    if (tagGrant.expr._tag === "some") {
      expect(tagGrant.expr.collection.steps[0]?.field).toEqual(field(taggableOwner, "tags"));
      expect(tagGrant.expr.pred._tag).toBe("exists");
      if (tagGrant.expr.pred._tag === "exists") {
        expect(tagGrant.expr.pred.entity).toEqual(entity("tag-grant"));
      }
    }

    expect(bound.decisions.entities[0]?.target).toEqual(entity("issue"));
    expect(bound.decisions.traits[0]?.target).toEqual(trait("taggable"));
    expect(bound.decisions.fields[0]?.target).toEqual(field(issueOwner, "internalNotes"));
    expect(bound.decisions.operations.map((entry) => entry.target)).toEqual([
      operation(issueOwner, "rename", "required"),
      operation(issueOwner, "create", "none"),
      operation(taggableOwner, "addTag", "required"),
      operation(taggableOwner, "reindex", "none"),
    ]);

    expect(operationRule(bound, issueOwner, "rename", "required").usesInput).toBe(true);
    expect(entityRule(bound, "issue").usesMe).toBe(true);
    expect(entityRule(bound, "issue").id).not.toBe(RULE_OWNS_ISSUE);
    expect(bound.decisions.entities[0]?.decision.allow).toEqual([entityRule(bound, "issue").id]);
  });

  test("rejects duplicate source rule IDs before remapping", () => {
    const template = fullTemplate();
    const first = template.rules[0]!;
    expectFailure(
      bindPolicyTemplateResult(
        bindingInput({
          template: {
            ...template,
            rules: [first, { ...first }],
            decisions: {
              entities: [
                {
                  target: { _tag: "RelativeEntityId", name: "issue" },
                  decision: { allow: [first.id], deny: [] },
                },
              ],
              traits: [],
              fields: [],
              operations: [],
            },
          },
        }),
      ),
      "InvalidIR",
      /duplicate source rule id/,
    );
  });

  test("rejects colliding source rule IDs that bind to different bodies", () => {
    const template = fullTemplate();
    const first = template.rules[0]!;
    const second = template.rules.find((entry) => entry.id !== first.id);
    if (second === undefined) throw new Error("expected a second template rule");
    expectFailure(
      bindPolicyTemplateResult(
        bindingInput({
          template: {
            ...template,
            rules: [first, { ...second, id: first.id }],
            decisions: {
              entities: [
                {
                  target: { _tag: "RelativeEntityId", name: "issue" },
                  decision: { allow: [first.id], deny: [] },
                },
              ],
              traits: [],
              fields: [],
              operations: [],
            },
          },
        }),
      ),
      "InvalidIR",
      /colliding source rule id/,
    );
  });

  test("converts JCS-invalid rule bodies into bind InvalidIR", () => {
    const template = fullTemplate();
    expectFailure(
      bindPolicyTemplateResult(
        bindingInput({
          template: {
            ...template,
            rules: [
              rule(
                RULE_OWNS_ISSUE,
                { _tag: "entity", entity: { _tag: "RelativeEntityId", name: "issue" } },
                { _tag: "hasClass", class: "member\uD800" },
              ),
            ],
            decisions: { entities: [], traits: [], fields: [], operations: [] },
          },
        }),
      ),
      "InvalidIR",
      /canonical hash failed|lone surrogate/,
    );
  });

  test("entity-owned and trait-owned targeted operations bind", () => {
    const bound = expectBound(bindPolicyTemplateResult(bindingInput()));
    expect(operationRule(bound, issueOwner, "rename", "required").focus).toEqual({
      _tag: "operation",
      operation: operation(issueOwner, "rename", "required"),
    });
    expect(operationRule(bound, taggableOwner, "addTag", "required").focus).toEqual({
      _tag: "operation",
      operation: operation(taggableOwner, "addTag", "required"),
    });
  });

  test("entity-owned and trait-owned targetless operations remain owned and bind only with target none", () => {
    const bound = expectBound(bindPolicyTemplateResult(bindingInput()));
    const create = operationRule(bound, issueOwner, "create", "none").focus;
    const reindex = operationRule(bound, taggableOwner, "reindex", "none").focus;
    expect(create).toEqual({
      _tag: "operation",
      operation: operation(issueOwner, "create", "none"),
    });
    expect(reindex).toEqual({
      _tag: "operation",
      operation: operation(taggableOwner, "reindex", "none"),
    });
    if (create?._tag === "operation") {
      expect(create.operation.owner).toEqual(issueOwner);
      expect(create.operation.target).toBe("none");
    }
    if (reindex?._tag === "operation") {
      expect(reindex.operation.owner).toEqual(taggableOwner);
      expect(reindex.operation.target).toBe("none");
    }
  });

  test("principal entity-field binding", () => {
    const bound = expectBound(bindPolicyTemplateResult(bindingInput()));
    expect(bound.principal).toEqual({
      subjectClaim: "sub",
      entity: field(userOwner, "authId"),
    });
  });

  test("principal without application row stays subject-only", () => {
    const template = fullTemplate();
    const bound = expectBound(
      bindPolicyTemplateResult(
        bindingInput({
          template: { ...template, principal: { subjectClaim: "sub" } },
        }),
      ),
    );
    expect(bound.principal).toEqual({ subjectClaim: "sub" });
    expect("entity" in bound.principal).toBe(false);
  });

  test("traversal-step and existential-entity binding", () => {
    const bound = expectBound(bindPolicyTemplateResult(bindingInput()));
    const owns = entityRule(bound, "issue");
    if (owns.expr._tag === "eq" && owns.expr.left._tag === "ref") {
      expect(owns.expr.left.steps.map((step) => step.field)).toEqual([field(issueOwner, "owner")]);
    } else {
      throw new Error("expected traversal eq");
    }
    const tagGrant = traitRule(bound, "taggable");
    if (tagGrant.expr._tag === "some" && tagGrant.expr.pred._tag === "exists") {
      expect(tagGrant.expr.pred.entity).toEqual(entity("tag-grant"));
    } else {
      throw new Error("expected exists");
    }
  });

  test("binding clones shared data so freeze does not seal caller inputs", () => {
    const template = fullTemplate();
    const descriptor = catalogDescriptor();
    const classes = template.classes as string[];
    const issueId = descriptor.entities.find((row) => row.id.name === "issue")!.id;
    const bound = expectBound(bindPolicyTemplateResult({ target, descriptor, template }));

    expect(Object.isFrozen(template)).toBe(false);
    expect(Object.isFrozen(template.classes)).toBe(false);
    expect(Object.isFrozen(template.claims)).toBe(false);
    expect(Object.isFrozen(descriptor)).toBe(false);
    expect(Object.isFrozen(issueId)).toBe(false);
    expect(Object.isFrozen(bound)).toBe(true);
    expect(Object.isFrozen(bound.classes)).toBe(true);
    expect(bound.principal.entity).not.toBe(descriptor.fields[0]?.id);

    classes.push("admin");
    expect(bound.classes).toEqual(["member"]);
    expect(() => {
      (bound.classes as string[]).push("support");
    }).toThrow();
  });

  test("claim and input terms have no identities and pass through", () => {
    const bound = expectBound(bindPolicyTemplateResult(bindingInput()));
    const rename = operationRule(bound, issueOwner, "rename", "required");
    expect(rename.expr._tag).toBe("and");
    if (rename.expr._tag === "and") {
      expect(rename.expr.exprs).toContainEqual({ _tag: "hasClass", class: "member" });
      expect(rename.expr.exprs).toContainEqual({
        _tag: "has",
        term: { _tag: "input", path: ["title"] },
      });
      expect(rename.expr.exprs).toContainEqual({
        _tag: "eq",
        left: { _tag: "subject" },
        right: { _tag: "claim", key: "org" },
      });
    }
  });
});

describe("identity resolution failures", () => {
  const withFocus = (focus: PolicyTemplateIR["rules"][number]["focus"]) => {
    const template = fullTemplate();
    return bindingInput({
      template: {
        ...template,
        rules: [rule(RULE_OWNS_ISSUE, focus, { _tag: "const", value: true })],
        decisions: { entities: [], traits: [], fields: [], operations: [] },
      },
    });
  };

  test("missing owner", () => {
    expectFailure(
      bindPolicyTemplateResult(
        withFocus({
          _tag: "field",
          field: relativeField({ kind: "entity", name: "ghost" }, "title"),
        }),
      ),
      "InvalidIR",
      /missing owner entity 'ghost'/,
    );
  });

  test("wrong owner kind", () => {
    expectFailure(
      bindPolicyTemplateResult(
        withFocus({
          _tag: "field",
          field: relativeField({ kind: "trait", name: "issue" }, "title"),
        }),
      ),
      "InvalidIR",
      /wrong owner kind/,
    );
    expectFailure(
      bindPolicyTemplateResult(
        withFocus({
          _tag: "operation",
          operation: relativeOperation({ kind: "trait", name: "issue" }, "rename", "required"),
        }),
      ),
      "InvalidIR",
      /wrong owner kind/,
    );
  });

  test("wrong local name", () => {
    expectFailure(
      bindPolicyTemplateResult(
        withFocus({
          _tag: "field",
          field: relativeField(issueOwner, "titel"),
        }),
      ),
      "InvalidIR",
      /wrong local name/,
    );
  });

  test("wrong target semantics", () => {
    expectFailure(
      bindPolicyTemplateResult(
        withFocus({
          _tag: "operation",
          operation: relativeOperation(issueOwner, "create", "required"),
        }),
      ),
      "InvalidIR",
      /wrong target semantics/,
    );
    expectFailure(
      bindPolicyTemplateResult(
        withFocus({
          _tag: "operation",
          operation: relativeOperation(issueOwner, "rename", "none"),
        }),
      ),
      "InvalidIR",
      /wrong target semantics/,
    );
  });

  test("missing identity", () => {
    expectFailure(
      bindPolicyTemplateResult(
        withFocus({ _tag: "entity", entity: { _tag: "RelativeEntityId", name: "project" } }),
      ),
      "InvalidIR",
      /missing entity 'project'/,
    );
    expectFailure(
      bindPolicyTemplateResult(
        withFocus({ _tag: "trait", trait: { _tag: "RelativeTraitId", name: "searchable" } }),
      ),
      "InvalidIR",
      /missing trait 'searchable'/,
    );
  });

  test("ambiguous identity in the catalog fails closed", () => {
    const descriptor = catalogDescriptor();
    expectFailure(
      bindPolicyTemplateResult(
        bindingInput({
          descriptor: {
            ...descriptor,
            entities: [...descriptor.entities, { id: entity("issue"), traits: [] }],
          },
        }),
      ),
      "InvalidIR",
      /ambiguous entity identity/,
    );
  });

  test("missing existential entity", () => {
    const template = fullTemplate();
    expectFailure(
      bindPolicyTemplateResult(
        bindingInput({
          template: {
            ...template,
            rules: [
              rule(
                RULE_OWNS_ISSUE,
                { _tag: "entity", entity: { _tag: "RelativeEntityId", name: "issue" } },
                {
                  _tag: "exists",
                  entity: { _tag: "RelativeEntityId", name: "missing-grant" },
                  bind: "row",
                  pred: { _tag: "const", value: true },
                },
              ),
            ],
          },
        }),
      ),
      "InvalidIR",
      /missing entity 'missing-grant'/,
    );
  });

  test("missing traversal-step field", () => {
    const template = fullTemplate();
    expectFailure(
      bindPolicyTemplateResult(
        bindingInput({
          template: {
            ...template,
            rules: [
              rule(
                RULE_OWNS_ISSUE,
                { _tag: "entity", entity: { _tag: "RelativeEntityId", name: "issue" } },
                {
                  _tag: "eq",
                  left: {
                    _tag: "ref",
                    root: { _tag: "resource" },
                    steps: [{ field: relativeField(issueOwner, "reporter") }],
                  },
                  right: { _tag: "me" },
                },
              ),
            ],
          },
        }),
      ),
      "InvalidIR",
      /wrong local name/,
    );
  });
});

describe("catalog and install-target failures", () => {
  test("cross-catalog descriptor", () => {
    expectFailure(
      bindPolicyTemplateResult(
        bindingInput({
          target: { ...target, catalog: CatalogId.make("other") },
        }),
      ),
      "CatalogMismatch",
      /cross-catalog descriptor/,
    );
  });

  test("cross-catalog identity inside the descriptor", () => {
    const descriptor = catalogDescriptor();
    const other = CatalogId.make("other");
    expectFailure(
      bindPolicyTemplateResult(
        bindingInput({
          descriptor: {
            ...descriptor,
            entities: [
              ...descriptor.entities.filter((row) => row.id.name !== "tag"),
              { id: EntityId.make({ catalog: other, name: "tag" }), traits: [] },
            ],
          },
        }),
      ),
      "CatalogMismatch",
      /cross-catalog entity/,
    );
  });

  test("cross-database attempt", () => {
    expectFailure(
      bindPolicyTemplateResult(
        bindingInput({
          target: { ...target, database: DatabaseId.make("other-db") },
        }),
      ),
      "CatalogMismatch",
      /cross-database catalog/,
    );
  });

  test("stale catalog version", () => {
    expectFailure(
      bindPolicyTemplateResult(
        bindingInput({
          target: { ...target, catalogVersion: CatalogVersion.make("0") },
        }),
      ),
      "CatalogMismatch",
      /stale catalog version/,
    );
  });

  test("schema fingerprint mismatch", () => {
    expectFailure(
      bindPolicyTemplateResult(
        bindingInput({
          target: { ...target, schemaFingerprint: SchemaFingerprint.make("other-schema") },
        }),
      ),
      "CatalogMismatch",
      /schema fingerprint mismatch/,
    );
  });

  test("blank catalog identity inputs fail before producing bound data", () => {
    expectFailure(
      bindPolicyTemplateResult(
        bindingInput({
          target: { ...target, catalog: CatalogId.make("") },
        }),
      ),
      "CatalogMismatch",
      /blank catalog id/,
    );
    expectFailure(
      bindPolicyTemplateResult(
        bindingInput({
          target: { ...target, catalogVersion: CatalogVersion.make("") },
        }),
      ),
      "CatalogMismatch",
      /blank catalog version/,
    );
    expectFailure(
      bindPolicyTemplateResult(
        bindingInput({
          target: { ...target, schemaFingerprint: SchemaFingerprint.make("") },
        }),
      ),
      "CatalogMismatch",
      /blank schema fingerprint/,
    );
  });
});

describe("bound IR is not installed IR", () => {
  test("runtime decode rejects a bound document", () => {
    const bound = expectBound(bindPolicyTemplateResult(bindingInput()));
    const asInstalled = {
      ...bound,
      _tag: "InstalledAuthorizationIR",
      version: INSTALLED_AUTHORIZATION_IR_VERSION,
    };
    const decoded = decodeInstalledAuthorizationResult(asInstalled);
    expect(Result.isFailure(decoded)).toBe(true);
    if (Result.isFailure(decoded)) {
      expect(decoded.failure).toBeInstanceOf(InvalidIR);
    }
  });

  test("BoundAuthorizationIR schema rejects installed and template tags", () => {
    const template = fullTemplate();
    expect(template._tag).toBe("PolicyTemplateIR");
    expect(template).not.toHaveProperty("database");
    const bound = expectBound(bindPolicyTemplateResult(bindingInput()));
    expect(bound._tag).toBe("BoundAuthorizationIR");
    expect(bound).not.toHaveProperty("policyHash");
  });
});

describe("Effect orchestration and catalog capability", () => {
  test("bindPolicyTemplate surfaces InvalidIR on the failure channel", async () => {
    const exit = await Effect.runPromiseExit(
      bindPolicyTemplate(
        bindingInput({
          template: {
            ...fullTemplate(),
            rules: [
              rule(
                RULE_OWNS_ISSUE,
                { _tag: "entity", entity: { _tag: "RelativeEntityId", name: "missing" } },
                { _tag: "const", value: true },
              ),
            ],
            decisions: { entities: [], traits: [], fields: [], operations: [] },
          },
        }),
      ),
    );
    expect(exit._tag).toBe("Failure");
    const failure = await Effect.runPromise(
      Effect.flip(
        bindPolicyTemplate(
          bindingInput({
            template: {
              ...fullTemplate(),
              rules: [
                rule(
                  RULE_OWNS_ISSUE,
                  { _tag: "entity", entity: { _tag: "RelativeEntityId", name: "missing" } },
                  { _tag: "const", value: true },
                ),
              ],
              decisions: { entities: [], traits: [], fields: [], operations: [] },
            },
          }),
        ),
      ),
    );
    expect(failure).toBeInstanceOf(InvalidIR);
    expect(failure._tag).toBe("InvalidIR");
    expect(failure.message).toMatch(/missing entity 'missing'/);
  });

  test("bindPolicyTemplate surfaces CatalogMismatch on the failure channel", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        bindPolicyTemplate(
          bindingInput({
            target: { ...target, catalogVersion: CatalogVersion.make("9") },
          }),
        ),
      ),
    );
    expect(failure).toBeInstanceOf(CatalogMismatch);
    expect(failure._tag).toBe("CatalogMismatch");
    expect(failure.message).toMatch(/stale catalog version/);
    if (failure._tag === "CatalogMismatch") {
      expect(failure.expectedVersion).toBe(CatalogVersion.make("9"));
      expect(failure.actualVersion).toBe(version);
    }
  });

  test("authoritative catalog capability resolves the exact target once", async () => {
    let resolves = 0;
    const service = {
      resolve: (requested: CatalogBindingTarget) => {
        resolves += 1;
        if (
          requested.database !== database ||
          requested.catalog !== catalog ||
          requested.catalogVersion !== version ||
          requested.schemaFingerprint !== fingerprint
        ) {
          return Effect.fail(
            new CatalogMismatch({
              message: "catalog target mismatch",
              expected: catalog,
              actual: requested.catalog,
            }),
          );
        }
        return Effect.succeed(catalogDescriptor());
      },
    };
    const bound = await Effect.runPromise(
      bindAgainstAuthoritativeCatalog(target, fullTemplate()).pipe(
        Effect.provideService(AuthoritativeCatalog, service),
      ),
    );
    expect(bound._tag).toBe("BoundAuthorizationIR");
    expect(bound.principal.entity).toEqual(field(userOwner, "authId"));
    expect(resolves).toBe(1);
  });

  test("catalog capability fails closed on a cross-database resolve", async () => {
    const service = {
      resolve: (requested: CatalogBindingTarget) =>
        Effect.fail(
          new CatalogMismatch({
            message: "cross-database catalog",
            expectedDatabase: database,
            actualDatabase: requested.database,
          }),
        ),
    };
    const failure = await Effect.runPromise(
      Effect.flip(
        bindAgainstAuthoritativeCatalog(
          { ...target, database: DatabaseId.make("other-db") },
          fullTemplate(),
        ).pipe(Effect.provideService(AuthoritativeCatalog, service)),
      ),
    );
    expect(failure).toBeInstanceOf(CatalogMismatch);
    expect(failure.message).toMatch(/cross-database catalog/);
    if (failure._tag === "CatalogMismatch") {
      expect(failure.actualDatabase).toBe(DatabaseId.make("other-db"));
    }
  });

  test("catalog capability InvalidIR stays on the failure channel", async () => {
    const service = {
      resolve: () => Effect.fail(new InvalidIR({ message: "catalog unavailable" })),
    };
    const failure = await Effect.runPromise(
      Effect.flip(
        bindAgainstAuthoritativeCatalog(target, fullTemplate()).pipe(
          Effect.provideService(AuthoritativeCatalog, service),
        ),
      ),
    );
    expect(failure).toBeInstanceOf(InvalidIR);
    expect(failure.message).toMatch(/catalog unavailable/);
  });

  test("capability cannot serve a catalog by relative name alone", async () => {
    const service = {
      resolve: (requested: CatalogBindingTarget) => {
        if (requested.schemaFingerprint !== fingerprint) {
          return Effect.fail(
            new CatalogMismatch({
              message: "schema fingerprint mismatch",
              expectedFingerprint: fingerprint,
              actualFingerprint: requested.schemaFingerprint,
            }),
          );
        }
        return Effect.succeed(catalogDescriptor());
      },
    };
    const failure = await Effect.runPromise(
      Effect.flip(
        bindAgainstAuthoritativeCatalog(
          { ...target, schemaFingerprint: SchemaFingerprint.make("guess") },
          fullTemplate(),
        ).pipe(Effect.provideService(AuthoritativeCatalog, service)),
      ),
    );
    expect(failure).toBeInstanceOf(CatalogMismatch);
    expect(failure.message).toMatch(/schema fingerprint mismatch/);
  });
});

describe("type distinction at the installed boundary", () => {
  test("template and bound values are not installed IR", () => {
    const template = fullTemplate();
    const bound = expectBound(bindPolicyTemplateResult(bindingInput()));
    // @ts-expect-error — template is not installed IR
    requireInstalled(template);
    // @ts-expect-error — bound intermediate is not installed IR
    requireInstalled(bound);
    expect(template._tag).toBe("PolicyTemplateIR");
    expect(bound._tag).toBe("BoundAuthorizationIR");
    expect(bound.version).toBe(BOUND_AUTHORIZATION_IR_VERSION);
  });
});
