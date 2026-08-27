/**
 * Access-plan derivation and installed-IR assembly.
 *
 * Binding and semantic validation are exercised only through the public
 * binder entry point. Runtime enforcement is out of scope.
 */

import { describe, expect, test } from "bun:test";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
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
  PolicyHash,
  RuleId,
  SchemaFingerprint,
  TraitId,
  VALIDATED_AUTHORIZATION_IR_VERSION,
  accessPlanCovers,
  assembleInstalledAuthorization,
  assembleInstalledAuthorizationResult,
  bindInstalledAgainstAuthoritativeCatalog,
  bindInstalledAuthorization,
  bindInstalledAuthorizationResult,
  canonicalizeInstalledAuthorization,
  decodeInstalledAuthorizationResult,
  deriveRuleAccessPlan,
  encodeInstalledAuthorization,
  hashCanonicalRuleSync,
  hashInstalledAuthorization,
  hashInstalledAuthorizationSync,
  missingAccessLookups,
  prepareAuthorizationCatalog,
  requireCompleteAccessPlan,
  validateBoundAuthorizationResult,
  type BoundAuthorizationIR,
  type CanonicalAuthorizationExpr,
  type CanonicalAuthorizationRule,
  type CanonicalRuleFocus,
  type CatalogBindingTarget,
  type CatalogDescriptor,
  type FieldRefTarget,
  type InstalledAuthorizationIR,
  type OwnerRef,
  type PolicyTemplateIR,
  type RuleAccessLookup,
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
  index = unique !== undefined,
): CatalogDescriptor["fields"][number] => ({
  id: field(owner, localName),
  valueType: "string",
  cardinality: "one",
  ...(unique === undefined ? {} : { unique }),
  index,
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
        fields: [{ key: "title", optional: false, shape: { _tag: "scalar", valueType: "string" } }],
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

const nestedCompositionDescriptor = (): CatalogDescriptor => ({
  id: catalog,
  database,
  version,
  fingerprint,
  entities: [
    { id: entity("user"), traits: [] },
    { id: entity("issue"), traits: [trait("tagged")] },
  ],
  traits: [
    { id: trait("tagged"), traits: [trait("named")] },
    { id: trait("named"), traits: [] },
  ],
  fields: [scalarField(userOwner, "authId", "upsert"), scalarField(issueOwner, "title")],
  operations: [],
  traitComposition: [
    {
      composer: entity("issue"),
      trait: trait("tagged"),
      transitive: [trait("tagged"), trait("named")],
    },
  ],
});

const twoTraitDescriptor = (): CatalogDescriptor => ({
  id: catalog,
  database,
  version,
  fingerprint,
  entities: [
    { id: entity("user"), traits: [] },
    { id: entity("issue"), traits: [trait("alpha"), trait("beta")] },
  ],
  traits: [
    { id: trait("alpha"), traits: [] },
    { id: trait("beta"), traits: [] },
  ],
  fields: [scalarField(userOwner, "authId", "upsert")],
  operations: [],
  traitComposition: [
    { composer: entity("issue"), trait: trait("alpha"), transitive: [trait("alpha")] },
    { composer: entity("issue"), trait: trait("beta"), transitive: [trait("beta")] },
  ],
});

const renameWithInput = (fields: CatalogDescriptor["operations"][number]["input"]): CatalogDescriptor => ({
  ...descriptor,
  operations: descriptor.operations.map((item) =>
    item.id.localName === "rename" ? { ...item, input: fields } : item,
  ),
});

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
    { _tag: "eq", left: resourceRef(step(issueOwner, "owner")), right: { _tag: "me" } },
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
            { _tag: "eq", left: bindRef("grant", step(grantOwner, "user")), right: { _tag: "me" } },
            { _tag: "eq", left: bindRef("grant", step(grantOwner, "tag")), right: { _tag: "bind", name: "tag" } },
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
      pred: { _tag: "eq", left: bindRef("grant", step(grantOwner, "user")), right: { _tag: "me" } },
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

const overlapsTags = () =>
  stamp(
    { _tag: "trait", trait: trait("taggable") },
    {
      _tag: "overlaps",
      left: resourceRef(step(taggableOwner, "tags")),
      right: resourceRef(step(taggableOwner, "tags")),
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

const targetedRename = () =>
  stamp(
    { _tag: "operation", operation: operation(issueOwner, "rename", "required") },
    { _tag: "eq", left: resourceRef(step(issueOwner, "owner")), right: { _tag: "me" } },
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

const fieldClass = () =>
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

const classOnly = (focus: CanonicalRuleFocus) =>
  stamp(focus, { _tag: "hasClass", class: "member" }, {
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

const expectOk = <A>(result: Result.Result<A, InvalidIR | CatalogMismatch>): A => {
  if (Result.isFailure(result)) throw result.failure;
  return result.success;
};

const expectFailure = (
  result: Result.Result<unknown, InvalidIR | CatalogMismatch>,
  tag: "InvalidIR" | "CatalogMismatch",
  pattern: RegExp,
) => {
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isSuccess(result)) throw new Error("expected assembly failure");
  expect(result.failure._tag).toBe(tag);
  expect(result.failure.message).toMatch(pattern);
  expect(result.failure._tag).not.toBe("AuthorizationDenied");
};

const validate = (bound: BoundAuthorizationIR, desc: CatalogDescriptor = descriptor) =>
  validateBoundAuthorizationResult({ bound, descriptor: desc });

const assembleFromBound = (
  bound: BoundAuthorizationIR,
  desc: CatalogDescriptor = descriptor,
): Result.Result<InstalledAuthorizationIR, InvalidIR | CatalogMismatch> => {
  const validated = validate(bound, desc);
  if (Result.isFailure(validated)) return Result.fail(validated.failure);
  return assembleInstalledAuthorizationResult({ validated: validated.success, descriptor: desc });
};

const planOf = (installed: InstalledAuthorizationIR, rule: CanonicalAuthorizationRule) => {
  const plan = installed.accessPlans.find((entry) => entry.rule === rule.id);
  if (plan === undefined) throw new Error(`missing plan for ${rule.id}`);
  return plan;
};

const lookupTags = (lookups: ReadonlyArray<RuleAccessLookup>) =>
  lookups.map((lookup) => {
    switch (lookup._tag) {
      case "entity":
        return `entity:${lookup.entity.name}`;
      case "exists":
        return `exists:${lookup.entity.name}:${lookup.fields.map((item) => item.localName).join(",")}`;
      case "field":
        return `field:${lookup.field.owner.name}.${lookup.field.localName}`;
      case "index":
        return `index:${lookup.field.owner.name}.${lookup.field.localName}`;
    }
  });

const relativeField = (owner: OwnerRef, localName: string) =>
  ({ _tag: "RelativeFieldId" as const, owner, localName });

const relativeTemplate = (): PolicyTemplateIR => ({
  _tag: "PolicyTemplateIR",
  version: POLICY_TEMPLATE_IR_VERSION,
  classes: ["member"],
  claims: [{ key: "org", optional: false, shape: { _tag: "scalar", valueType: "string" } }],
  principal: { subjectClaim: "sub", entity: relativeField(userOwner, "authId") },
  rules: [
    {
      id: RuleId.make(digestHex(0x11)),
      focus: { _tag: "entity", entity: { _tag: "RelativeEntityId", name: "issue" } },
      expr: {
        _tag: "eq",
        left: {
          _tag: "ref",
          root: { _tag: "resource" },
          steps: [{ field: relativeField(issueOwner, "owner") }],
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
    {
      id: RuleId.make(digestHex(0x22)),
      focus: {
        _tag: "operation",
        operation: {
          _tag: "RelativeOperationId",
          owner: issueOwner,
          localName: "rename",
          target: "required",
        },
      },
      expr: {
        _tag: "and",
        exprs: [
          { _tag: "hasClass", class: "member" },
          { _tag: "has", term: { _tag: "input", path: ["title"] } },
          { _tag: "eq", left: { _tag: "subject" }, right: { _tag: "claim", key: "org" } },
        ],
      },
      usesResource: false,
      usesInput: true,
      usesMe: false,
      usesSubject: true,
      traversalDepth: 0,
      existsDepth: 0,
      dependencies: [],
    },
    {
      id: RuleId.make(digestHex(0x33)),
      focus: { _tag: "trait", trait: { _tag: "RelativeTraitId", name: "taggable" } },
      expr: {
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
            ],
          },
        },
      },
      usesResource: true,
      usesInput: false,
      usesMe: true,
      usesSubject: false,
      traversalDepth: 1,
      existsDepth: 1,
      dependencies: [],
    },
  ],
  decisions: {
    entities: [
      {
        target: { _tag: "RelativeEntityId", name: "issue" },
        decision: { allow: [RuleId.make(digestHex(0x11))], deny: [] },
      },
    ],
    traits: [
      {
        target: { _tag: "RelativeTraitId", name: "taggable" },
        decision: { allow: [RuleId.make(digestHex(0x33))], deny: [] },
      },
    ],
    fields: [],
    operations: [
      {
        target: {
          _tag: "RelativeOperationId",
          owner: issueOwner,
          localName: "rename",
          target: "required",
        },
        decision: { allow: [RuleId.make(digestHex(0x22))], deny: [] },
      },
    ],
  },
});

const requireInstalled = (_ir: InstalledAuthorizationIR): void => undefined;

const walkPlain = (value: unknown, visit: (node: unknown) => void): void => {
  visit(value);
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) walkPlain(item, visit);
    return;
  }
  for (const key of Object.keys(value)) {
    walkPlain((value as Record<string, unknown>)[key], visit);
  }
};

const shuffle = <T>(items: ReadonlyArray<T>, seed: number): T[] => {
  const copy = [...items];
  let state = seed >>> 0;
  for (let i = copy.length - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1);
    const left = copy[i]!;
    copy[i] = copy[j]!;
    copy[j] = left;
  }
  return copy;
};

describe("binder entry point", () => {
  test("CatalogBindingInput produces sealed InstalledAuthorizationIR", () => {
    const installed = expectOk(
      bindInstalledAuthorizationResult({
        target,
        descriptor,
        template: relativeTemplate(),
      }),
    );
    expect(installed._tag).toBe("InstalledAuthorizationIR");
    expect(installed.version).toBe(INSTALLED_AUTHORIZATION_IR_VERSION);
    expect(installed.database).toBe(database);
    expect(installed.catalog).toBe(catalog);
    expect(installed.catalogVersion).toBe(version);
    expect(installed.schemaFingerprint).toBe(fingerprint);
    expect(installed.accessPlans).toHaveLength(installed.rules.length);
    expect(installed.policyHash).toBe(hashInstalledAuthorizationSync(installed));
  });

  test("every validated rule has exactly one complete access plan", () => {
    const owns = ownsIssue();
    const tagged = tagGrant();
    const notes = fieldClass();
    const create = createInput();
    const installed = expectOk(
      assembleFromBound(
        boundDocument(
          [owns, tagged, notes, create],
          {
            entities: [{ target: entity("issue"), decision: { allow: [owns.id], deny: [] } }],
            traits: [{ target: trait("taggable"), decision: { allow: [tagged.id], deny: [] } }],
            fields: [{ target: field(issueOwner, "internalNotes"), decision: { allow: [notes.id], deny: [] } }],
            operations: [
              { target: operation(issueOwner, "create", "none"), decision: { allow: [create.id], deny: [] } },
            ],
          },
        ),
      ),
    );
    expect(installed.accessPlans.map((plan) => plan.rule).sort()).toEqual(
      installed.rules.map((rule) => rule.id).sort(),
    );
    expect(new Set(installed.accessPlans.map((plan) => plan.rule)).size).toBe(4);
  });
});

describe("access plans", () => {
  test("Taggable -> Tag -> TagGrant plan is complete", () => {
    const rule = tagGrant();
    const installed = expectOk(
      assembleFromBound(
        boundDocument([rule], {
          entities: [],
          traits: [{ target: trait("taggable"), decision: { allow: [rule.id], deny: [] } }],
          fields: [],
          operations: [],
        }),
      ),
    );
    const tags = lookupTags(planOf(installed, rule).lookups);
    expect(tags).toContain("entity:issue");
    expect(tags).toContain("entity:tag");
    expect(tags).toContain("entity:tag-grant");
    expect(tags).toContain("entity:user");
    expect(tags).toContain("field:taggable.tags");
    expect(tags).toContain("field:tag-grant.user");
    expect(tags).toContain("field:tag-grant.tag");
    expect(tags).toContain("exists:tag-grant:tag,user");
    expect(tags).toContain("field:user.authId");
    expect(tags).toContain("index:user.authId");
  });

  test("direct field, multi-hop ref, some, overlaps, and exists plans", () => {
    const direct = ownsIssue();
    const multi = nestedTagGrant();
    const overlap = overlapsTags();
    const exists = tagGrant();
    const installed = expectOk(assembleFromBound(boundDocument([direct, multi, overlap, exists])));
    expect(lookupTags(planOf(installed, direct).lookups)).toEqual(
      expect.arrayContaining(["entity:issue", "field:issue.owner", "entity:user", "index:user.authId"]),
    );
    const multiTags = lookupTags(planOf(installed, multi).lookups);
    expect(multiTags).toEqual(
      expect.arrayContaining(["field:taggable.tags", "field:tag.grants", "field:tag-grant.user", "entity:tag"]),
    );
    expect(multiTags.some((tag) => tag.startsWith("exists:"))).toBe(false);
    expect(lookupTags(planOf(installed, overlap).lookups)).toEqual(
      expect.arrayContaining(["field:taggable.tags", "entity:tag"]),
    );
    expect(lookupTags(planOf(installed, exists).lookups).some((tag) => tag.startsWith("exists:tag-grant"))).toBe(
      true,
    );
  });

  test("principal-row, claim/class-only, targeted, and targetless operation plans", () => {
    const principal = ownsIssue();
    const claims = renameInput();
    const targeted = targetedRename();
    const targetless = createInput();
    const installed = expectOk(assembleFromBound(boundDocument([principal, claims, targeted, targetless])));
    expect(lookupTags(planOf(installed, principal).lookups)).toContain("index:user.authId");
    expect(lookupTags(planOf(installed, claims).lookups)).toEqual([]);
    expect(lookupTags(planOf(installed, targeted).lookups)).toEqual(
      expect.arrayContaining(["entity:issue", "field:issue.owner", "index:user.authId"]),
    );
    expect(lookupTags(planOf(installed, targetless).lookups)).toEqual([]);
  });

  test("plans for entity, trait, field, and operation decisions", () => {
    const entityRule = ownsIssue();
    const traitRule = classOnly({ _tag: "trait", trait: trait("taggable") });
    const fieldRule = fieldClass();
    const operationRule = createInput();
    const installed = expectOk(
      assembleFromBound(
        boundDocument(
          [entityRule, traitRule, fieldRule, operationRule],
          {
            entities: [{ target: entity("issue"), decision: { allow: [entityRule.id], deny: [] } }],
            traits: [{ target: trait("taggable"), decision: { allow: [traitRule.id], deny: [] } }],
            fields: [
              { target: field(issueOwner, "internalNotes"), decision: { allow: [fieldRule.id], deny: [] } },
            ],
            operations: [
              {
                target: operation(issueOwner, "create", "none"),
                decision: { allow: [operationRule.id], deny: [] },
              },
            ],
          },
        ),
      ),
    );
    expect(planOf(installed, entityRule).lookups.length).toBeGreaterThan(0);
    expect(planOf(installed, traitRule).lookups).toEqual([]);
    expect(planOf(installed, fieldRule).lookups).toEqual([]);
    expect(planOf(installed, operationRule).lookups).toEqual([]);
    expect(installed.decisions.entities).toHaveLength(1);
    expect(installed.decisions.traits).toHaveLength(1);
    expect(installed.decisions.fields).toHaveLength(1);
    expect(installed.decisions.operations).toHaveLength(1);
  });

  test("omitted required lookups fail closed", () => {
    const rule = ownsIssue();
    const validated = expectOk(validate(boundDocument([rule])));
    const index = expectOk(prepareAuthorizationCatalog(target, descriptor));
    const plan = expectOk(deriveRuleAccessPlan(index, rule, validated.principal));
    const omitted = {
      ...plan,
      lookups: plan.lookups.filter((lookup) => lookup._tag !== "index"),
    };
    expect(accessPlanCovers(omitted.lookups, plan.lookups)).toBe(false);
    expect(missingAccessLookups(omitted.lookups, plan.lookups).some((lookup) => lookup._tag === "index")).toBe(
      true,
    );
    expectFailure(requireCompleteAccessPlan(omitted, plan.lookups), "InvalidIR", /omitted/);
  });

  test("exists lookups cover by field-set inclusion and ignore field order", () => {
    const grant = entity("tag-grant");
    const userField = field(grantOwner, "user");
    const tagField = field(grantOwner, "tag");
    const requiredSubset: ReadonlyArray<RuleAccessLookup> = [
      { _tag: "exists", entity: grant, fields: [userField] },
    ];
    const requiredBoth: ReadonlyArray<RuleAccessLookup> = [
      { _tag: "exists", entity: grant, fields: [tagField, userField] },
    ];
    const actualSuperset: ReadonlyArray<RuleAccessLookup> = [
      { _tag: "exists", entity: grant, fields: [tagField, userField] },
    ];
    const actualReordered: ReadonlyArray<RuleAccessLookup> = [
      { _tag: "exists", entity: grant, fields: [userField, tagField] },
    ];
    expect(accessPlanCovers(actualSuperset, requiredSubset)).toBe(true);
    expect(accessPlanCovers(actualReordered, requiredBoth)).toBe(true);
    expect(accessPlanCovers(requiredSubset, actualSuperset)).toBe(false);
    expect(missingAccessLookups(actualSuperset, requiredSubset)).toEqual([]);
    expect(missingAccessLookups(actualReordered, requiredBoth)).toEqual([]);
    expect(missingAccessLookups(requiredSubset, actualSuperset)).toEqual(actualSuperset);
    expect(Result.isSuccess(requireCompleteAccessPlan({ rule: RuleId.make(digestHex(1)), lookups: actualSuperset }, requiredSubset))).toBe(
      true,
    );
  });

  test("required principal index that cannot be represented fails", () => {
    const desc: CatalogDescriptor = {
      ...descriptor,
      fields: descriptor.fields.map((item) =>
        item.id.localName === "authId" ? { ...item, unique: "upsert" as const, index: false } : item,
      ),
    };
    expectFailure(assembleFromBound(boundDocument([ownsIssue()]), desc), "InvalidIR", /required index/);
  });
});

describe("normalization and collisions", () => {
  test("duplicate catalog identities fail closed", () => {
    const desc: CatalogDescriptor = {
      ...descriptor,
      entities: [...descriptor.entities, { id: entity("issue"), traits: [trait("taggable")] }],
    };
    expectFailure(assembleFromBound(boundDocument([ownsIssue()]), desc), "InvalidIR", /ambiguous entity/);
  });

  test("conflicting trait composition fails closed", () => {
    const desc: CatalogDescriptor = {
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
      assembleFromBound(boundDocument([tagGrant()]), desc),
      "InvalidIR",
      /contradictory trait composition/,
    );
  });

  test("duplicate decoded identities, operations, composition, rules, decisions, and plans fail", () => {
    const installed = expectOk(
      bindInstalledAuthorizationResult({
        target,
        descriptor,
        template: relativeTemplate(),
      }),
    );
    const encoded = JSON.parse(JSON.stringify(encodeInstalledAuthorization(installed))) as ReturnType<
      typeof encodeInstalledAuthorization
    >;
    const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
    expectFailure(
      decodeInstalledAuthorizationResult({
        ...encoded,
        identities: {
          ...encoded.identities,
          entities: [...encoded.identities.entities, ...clone(encoded.identities.entities)],
        },
      }),
      "InvalidIR",
      /duplicate entity identity/,
    );
    expectFailure(
      decodeInstalledAuthorizationResult({
        ...encoded,
        operations: [...encoded.operations, ...clone(encoded.operations)],
      }),
      "InvalidIR",
      /duplicate operation identity/,
    );
    expectFailure(
      decodeInstalledAuthorizationResult({
        ...encoded,
        traitComposition: [...encoded.traitComposition, ...clone(encoded.traitComposition)],
      }),
      "InvalidIR",
      /duplicate trait-composition identity/,
    );
    expectFailure(
      decodeInstalledAuthorizationResult({
        ...encoded,
        rules: [...encoded.rules, ...clone(encoded.rules)],
      }),
      "InvalidIR",
      /duplicate rule identity/,
    );
    expectFailure(
      decodeInstalledAuthorizationResult({
        ...encoded,
        decisions: {
          ...encoded.decisions,
          entities: [...encoded.decisions.entities, ...clone(encoded.decisions.entities)],
        },
      }),
      "InvalidIR",
      /duplicate entity decision target/,
    );
    expectFailure(
      decodeInstalledAuthorizationResult({
        ...encoded,
        accessPlans: [...encoded.accessPlans, ...clone(encoded.accessPlans)],
      }),
      "InvalidIR",
      /duplicate access-plan identity/,
    );
  });

  test("output tables are collision-free and sorted", () => {
    const installed = expectOk(assembleFromBound(boundDocument([ownsIssue(), tagGrant(), renameInput()])));
    const names = installed.identities.entities.map((item) => item.name);
    expect(names).toEqual([...names].sort());
    expect(new Set(names).size).toBe(names.length);
    const fieldKeys = installed.identities.fields.map(
      (item) => `${item.owner.kind}:${item.owner.name}.${item.localName}`,
    );
    expect(fieldKeys).toEqual([...fieldKeys].sort());
    expect(new Set(fieldKeys).size).toBe(fieldKeys.length);
    expect(installed.rules.map((rule) => rule.id)).toEqual([...installed.rules.map((rule) => rule.id)].sort());
    expect(installed.accessPlans.map((plan) => plan.rule)).toEqual(
      [...installed.accessPlans.map((plan) => plan.rule)].sort(),
    );
  });

  test("nested trait composition does not require a transitive entity row", () => {
    const desc = nestedCompositionDescriptor();
    const rule = classOnly({ _tag: "entity", entity: entity("issue") });
    const installed = expectOk(
      assembleFromBound(
        boundDocument(
          [rule],
          {
            entities: [{ target: entity("issue"), decision: { allow: [rule.id], deny: [] } }],
            traits: [],
            fields: [],
            operations: [],
          },
        ),
        desc,
      ),
    );
    expect(installed.traitComposition).toHaveLength(1);
    expect(installed.traitComposition[0]?.composer.name).toBe("issue");
    expect(installed.traitComposition[0]?.trait.name).toBe("tagged");
    expect(installed.traitComposition[0]?.transitive.map((item) => item.name)).toEqual(["named", "tagged"]);
    expect(installed.identities.traits.map((item) => item.name)).toEqual(["named", "tagged"]);
  });

  test("trait-owned field and class-only trait operation include composer rows", () => {
    const tags = classOnly({ _tag: "field", field: field(taggableOwner, "tags") });
    const reindex = classOnly({
      _tag: "operation",
      operation: operation(taggableOwner, "reindex", "none"),
    });
    const fieldInstalled = expectOk(
      assembleFromBound(
        boundDocument(
          [tags],
          {
            entities: [],
            traits: [],
            fields: [{ target: field(taggableOwner, "tags"), decision: { allow: [tags.id], deny: [] } }],
            operations: [],
          },
        ),
      ),
    );
    expect(fieldInstalled.identities.traits.some((item) => item.name === "taggable")).toBe(true);
    expect(
      fieldInstalled.traitComposition.some(
        (row) => row.composer.name === "issue" && row.trait.name === "taggable",
      ),
    ).toBe(true);
    const operationInstalled = expectOk(
      assembleFromBound(
        boundDocument(
          [reindex],
          {
            entities: [],
            traits: [],
            fields: [],
            operations: [
              {
                target: operation(taggableOwner, "reindex", "none"),
                decision: { allow: [reindex.id], deny: [] },
              },
            ],
          },
        ),
      ),
    );
    expect(operationInstalled.identities.traits.some((item) => item.name === "taggable")).toBe(true);
    expect(
      operationInstalled.traitComposition.some(
        (row) => row.composer.name === "issue" && row.trait.name === "taggable",
      ),
    ).toBe(true);
  });
});

describe("determinism, hash, and catalog identity", () => {
  test("randomized catalog order does not change installed IR", () => {
    const owns = ownsIssue();
    const tagged = tagGrant();
    const left = expectOk(assembleFromBound(boundDocument([owns, tagged])));
    const shuffled: CatalogDescriptor = {
      ...descriptor,
      entities: shuffle(descriptor.entities, 7),
      traits: shuffle(descriptor.traits, 11),
      fields: shuffle(descriptor.fields, 13),
      operations: shuffle(descriptor.operations, 17),
      traitComposition: shuffle(descriptor.traitComposition, 19),
    };
    const right = expectOk(
      assembleFromBound(
        boundDocument([tagged, owns], {
          entities: [],
          traits: [],
          fields: [],
          operations: [],
        }),
        shuffled,
      ),
    );
    expect(canonicalizeInstalledAuthorization(left)).toBe(canonicalizeInstalledAuthorization(right));
    expect(left.policyHash).toBe(right.policyHash);
  });

  test("shuffled two-trait composition order does not change installed IR", () => {
    const desc = twoTraitDescriptor();
    const rule = classOnly({ _tag: "trait", trait: trait("alpha") });
    const document = boundDocument(
      [rule],
      {
        entities: [],
        traits: [{ target: trait("alpha"), decision: { allow: [rule.id], deny: [] } }],
        fields: [],
        operations: [],
      },
    );
    const left = expectOk(assembleFromBound(document, desc));
    const right = expectOk(
      assembleFromBound(document, {
        ...desc,
        traitComposition: [...desc.traitComposition].reverse(),
      }),
    );
    expect(left.traitComposition.map((row) => `${row.composer.name}/${row.trait.name}`)).toEqual([
      "issue/alpha",
      "issue/beta",
    ]);
    expect(canonicalizeInstalledAuthorization(left)).toBe(canonicalizeInstalledAuthorization(right));
    expect(left.policyHash).toBe(right.policyHash);
  });

  test("shuffled operation input struct fields do not change policy hash", () => {
    const nested = (keys: ReadonlyArray<string>) =>
      keys.map((key) => ({
        key,
        optional: false,
        shape: { _tag: "scalar" as const, valueType: "string" as const },
      }));
    const title = {
      key: "title",
      optional: false,
      shape: { _tag: "scalar" as const, valueType: "string" as const },
    };
    const meta = (keys: ReadonlyArray<string>) => ({
      key: "meta",
      optional: false,
      shape: { _tag: "struct" as const, fields: nested(keys) },
    });
    const left = expectOk(
      assembleFromBound(boundDocument([renameInput()]), renameWithInput({
        _tag: "struct",
        fields: [meta(["z", "a"]), title],
      })),
    );
    const right = expectOk(
      assembleFromBound(boundDocument([renameInput()]), renameWithInput({
        _tag: "struct",
        fields: [title, meta(["a", "z"])],
      })),
    );
    const input = left.operations.find((item) => item.id.localName === "rename")?.input;
    expect(input).toEqual({
      _tag: "struct",
      fields: [
        {
          key: "meta",
          optional: false,
          shape: {
            _tag: "struct",
            fields: [
              { key: "a", optional: false, shape: { _tag: "scalar", valueType: "string" } },
              { key: "z", optional: false, shape: { _tag: "scalar", valueType: "string" } },
            ],
          },
        },
        title,
      ],
    });
    expect(left.policyHash).toBe(right.policyHash);
    expect(canonicalizeInstalledAuthorization(left)).toBe(canonicalizeInstalledAuthorization(right));
  });

  test("golden installed IR serialization and policy hash", () => {
    const installed = expectOk(
      bindInstalledAuthorizationResult({
        target,
        descriptor,
        template: relativeTemplate(),
      }),
    );
    const canonical = canonicalizeInstalledAuthorization(installed);
    expect(installed.policyHash).toBe(hashInstalledAuthorizationSync(installed));
    expect(canonical.startsWith('{"_tag":"InstalledAuthorizationIR","accessPlans":[')).toBe(true);
    expect(canonical).toContain('"policyHash":"621f30d09902a3a118544e432c71be0db1cfe7aa5d65e0d79dbc99b8e30b727a"');
    expect(canonical.length).toBe(6641);
    expect(hashInstalledAuthorizationSync(installed)).toBe(
      PolicyHash.make("621f30d09902a3a118544e432c71be0db1cfe7aa5d65e0d79dbc99b8e30b727a"),
    );
  });

  test("encode/decode/hash round trip preserves canonical bytes", () => {
    const installed = expectOk(assembleFromBound(boundDocument([ownsIssue(), tagGrant()])));
    const encoded = encodeInstalledAuthorization(installed);
    const decoded = expectOk(decodeInstalledAuthorizationResult(encoded));
    expect(canonicalizeInstalledAuthorization(decoded)).toBe(canonicalizeInstalledAuthorization(installed));
    expect(decoded.policyHash).toBe(installed.policyHash);
    expect(hashInstalledAuthorizationSync(decoded)).toBe(installed.policyHash);
  });

  test("catalog, database, version, and fingerprint are populated from the target", () => {
    const installed = expectOk(assembleFromBound(boundDocument([ownsIssue()])));
    expect(installed.database).toBe(database);
    expect(installed.catalog).toBe(catalog);
    expect(installed.catalogVersion).toBe(version);
    expect(installed.schemaFingerprint).toBe(fingerprint);
    expect(installed.identities.entities.some((item) => item.name === "issue")).toBe(true);
    expect(installed.traitComposition[0]?.composer.name).toBe("issue");
    expect(installed.traitComposition[0]?.trait.name).toBe("taggable");
  });
});

describe("immutability and type boundary", () => {
  test("installed IR is deeply immutable plain data", () => {
    const installed = expectOk(assembleFromBound(boundDocument([ownsIssue()])));
    walkPlain(installed, (node) => {
      if (node !== null && typeof node === "object") {
        expect(Object.isFrozen(node)).toBe(true);
        expect(Object.getPrototypeOf(node) === Object.prototype || Array.isArray(node)).toBe(true);
      }
      expect(typeof node).not.toBe("function");
    });
    expect(() => {
      (installed as { policyHash: string }).policyHash = "x";
    }).toThrow();
  });

  test("template, bound, and validated values are not installed IR", () => {
    const template = relativeTemplate();
    const bound = boundDocument([ownsIssue()]);
    const validated = expectOk(validate(bound));
    // @ts-expect-error — template is not installed IR
    requireInstalled(template);
    // @ts-expect-error — bound intermediate is not installed IR
    requireInstalled(bound);
    // @ts-expect-error — validated intermediate is not installed IR
    requireInstalled(validated);
    const partial: Pick<ValidatedAuthorizationIR, "rules" | "decisions"> = {
      rules: validated.rules,
      decisions: validated.decisions,
    };
    // @ts-expect-error — partial bound/validated is not installed IR
    requireInstalled(partial);
    expect(template._tag).toBe("PolicyTemplateIR");
    expect(bound._tag).toBe("BoundAuthorizationIR");
    expect(validated._tag).toBe("ValidatedAuthorizationIR");
    expect(validated.version).toBe(VALIDATED_AUTHORIZATION_IR_VERSION);
    expect("policyHash" in validated).toBe(false);
    expect("accessPlans" in validated).toBe(false);
  });
});

describe("Effect orchestration", () => {
  test("bindInstalledAuthorization surfaces InvalidIR and CatalogMismatch", async () => {
    const invalid = await Effect.runPromise(
      Effect.flip(
        bindInstalledAuthorization({
          target,
          descriptor,
          template: {
            ...relativeTemplate(),
            rules: [
              {
                ...relativeTemplate().rules[0]!,
                focus: { _tag: "entity", entity: { _tag: "RelativeEntityId", name: "missing" } },
              },
            ],
            decisions: { entities: [], traits: [], fields: [], operations: [] },
          },
        }),
      ),
    );
    expect(invalid).toBeInstanceOf(InvalidIR);
    const mismatch = await Effect.runPromise(
      Effect.flip(
        bindInstalledAuthorization({
          target: { ...target, catalogVersion: CatalogVersion.make("9") },
          descriptor,
          template: relativeTemplate(),
        }),
      ),
    );
    expect(mismatch).toBeInstanceOf(CatalogMismatch);
    expect(mismatch.message).toMatch(/stale catalog version/);
  });

  test("authoritative catalog failure stays on the failure channel", async () => {
    const service = {
      resolve: () => Effect.fail(new InvalidIR({ message: "catalog unavailable" })),
    };
    const failure = await Effect.runPromise(
      Effect.flip(
        bindInstalledAgainstAuthoritativeCatalog(target, relativeTemplate()).pipe(
          Effect.provideService(AuthoritativeCatalog, service),
        ),
      ),
    );
    expect(failure).toBeInstanceOf(InvalidIR);
    expect(failure.message).toMatch(/catalog unavailable/);
  });

  test("interruption at the catalog capability boundary", async () => {
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const fiber = yield* Effect.forkChild(
          bindInstalledAgainstAuthoritativeCatalog(target, relativeTemplate()).pipe(
            Effect.provideService(AuthoritativeCatalog, {
              resolve: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
            }),
          ),
        );
        yield* Deferred.await(started);
        yield* Fiber.interrupt(fiber);
        return yield* Fiber.await(fiber);
      }),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(Cause.hasInterrupts(exit.cause)).toBe(true);
    }
  });

  test("assembleInstalledAuthorization is an Effect shell around the pure kernel", async () => {
    const validated = expectOk(validate(boundDocument([ownsIssue()])));
    const installed = await Effect.runPromise(
      assembleInstalledAuthorization({ validated, descriptor }),
    );
    expect(installed._tag).toBe("InstalledAuthorizationIR");
    expect(await Effect.runPromise(hashInstalledAuthorization(installed))).toBe(installed.policyHash);
  });

  test("AuthoritativeCatalog is resolved once at the outer boundary", async () => {
    let resolves = 0;
    const installed = await Effect.runPromise(
      bindInstalledAgainstAuthoritativeCatalog(target, relativeTemplate()).pipe(
        Effect.provideService(AuthoritativeCatalog, {
          resolve: () => {
            resolves += 1;
            return Effect.succeed(descriptor);
          },
        }),
      ),
    );
    expect(installed._tag).toBe("InstalledAuthorizationIR");
    expect(resolves).toBe(1);
  });
});
