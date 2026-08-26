/**
 * Type-level fixtures for the authorization identity / IR vocabulary.
 *
 * `bun run typecheck` compiles this file. A mismatch turns `Expect<Equal<…>>`
 * into a type error, or leaves a `@ts-expect-error` unused.
 */

import { expect, test } from "bun:test";
import type { Equal, Expect, Extends } from "../../../src/db/equal.ts";
import {
  AuthorizationDenied,
  AuthorizationBudgetExceeded,
  BudgetExhausted,
  CatalogId,
  CatalogMismatch,
  CatalogVersion,
  DatabaseId,
  DEFAULT_AUTHORIZATION_BUDGET,
  EntityAbsent,
  EntityId,
  False,
  FieldAbsent,
  FieldId,
  Incomplete,
  IncompleteRuleSnapshot,
  INSTALLED_AUTHORIZATION_IR_VERSION,
  InvalidIR,
  InvalidTraversal,
  LeaseExpired,
  MAX_EXISTS_DEPTH,
  MAX_READ_LEASE_MS,
  MAX_TRAVERSAL_DEPTH,
  MissingMe,
  MissingMeProjection,
  NotLoaded,
  OperationId,
  POLICY_TEMPLATE_IR_VERSION,
  PolicyHash,
  Present,
  RelativeFieldId,
  RelativeOperationId,
  RuleId,
  SchemaFingerprint,
  TraitId,
  True,
  type AuthorizationFailure,
  type AuthorizationPrincipal,
  type CatalogBindingInput,
  type CatalogDescriptor,
  type CompleteProjected,
  type FieldDescriptor,
  type IncompleteProjected,
  type InstalledAuthorizationIR,
  type OperationId as OperationIdType,
  type OperationInputFieldDescriptor,
  type PolicyTemplateIR,
  type Present as PresentType,
  type Projected,
  type RelativeOperationId as RelativeOperationIdType,
  type Truth,
} from "../../../src/internal/authorization/index.ts";

// @ts-expect-error — not a public package export yet
import type { PolicyTemplateIR as _PublicTemplate } from "ramose";
// @ts-expect-error — not a public package export yet
import type { InstalledAuthorizationIR as _PublicInstalled } from "ramose/db";

type PublicKeys = keyof typeof import("ramose");
type _noPublicAuthorization = Expect<
  Equal<Extract<PublicKeys, "Authorization" | "PolicyTemplateIR" | "InstalledAuthorizationIR">, never>
>;

const catalog = CatalogId("app");
const issueOwner = { kind: "entity" as const, name: "issue" };
const taggableOwner = { kind: "trait" as const, name: "taggable" };

type OwnerlessOperation = {
  readonly _tag: "OperationId";
  readonly catalog: typeof catalog;
  readonly localName: "create";
  readonly target: "none";
};

type TargetOmittedOperation = {
  readonly _tag: "OperationId";
  readonly catalog: typeof catalog;
  readonly owner: typeof issueOwner;
  readonly localName: "create";
};

type OwnerAsTarget = {
  readonly _tag: "OperationId";
  readonly catalog: typeof catalog;
  readonly owner: "none";
  readonly localName: "create";
  readonly target: typeof issueOwner;
};

type _ownerRequired = Expect<Equal<Extends<OwnerlessOperation, OperationIdType>, false>>;
type _targetRequired = Expect<Equal<Extends<TargetOmittedOperation, OperationIdType>, false>>;
type _ownerAndTargetIndependent = Expect<Equal<Extends<OwnerAsTarget, OperationIdType>, false>>;

type TargetlessOwned = {
  readonly _tag: "OperationId";
  readonly catalog: typeof catalog;
  readonly owner: typeof issueOwner;
  readonly localName: "create";
  readonly target: "none";
};
type _targetNoneWithOwner = Expect<Extends<TargetlessOwned, OperationIdType>>;

type TraitTargeted = {
  readonly _tag: "OperationId";
  readonly catalog: typeof catalog;
  readonly owner: typeof taggableOwner;
  readonly localName: "addTag";
  readonly target: "required";
};
type _traitOwnerSupported = Expect<Extends<TraitTargeted, OperationIdType>>;

type RelativeOwnerless = {
  readonly _tag: "RelativeOperationId";
  readonly localName: "create";
  readonly target: "none";
};
type _relativeOwnerRequired = Expect<
  Equal<Extends<RelativeOwnerless, RelativeOperationIdType>, false>
>;

type _templateNotInstalled = Expect<
  Equal<Extends<PolicyTemplateIR, InstalledAuthorizationIR>, false>
>;
type _installedNotTemplate = Expect<
  Equal<Extends<InstalledAuthorizationIR, PolicyTemplateIR>, false>
>;

type PrincipalWithoutSubject = {
  readonly claims: {};
  readonly classes: readonly [];
};
type _subjectRequired = Expect<
  Equal<Extends<PrincipalWithoutSubject, AuthorizationPrincipal>, false>
>;

type ServicePrincipal = {
  readonly subject: "svc";
  readonly claims: {};
  readonly classes: readonly [];
};
type _meOptional = Expect<Extends<ServicePrincipal, AuthorizationPrincipal>>;
type _emptyClassesAllowed = Expect<Extends<ServicePrincipal, AuthorizationPrincipal>>;

type _absentIsNotUndefined = Expect<
  Equal<Extends<undefined, Projected>, false>
>;
type _incompleteIsNotPresent = Expect<
  Equal<Extends<IncompleteProjected, typeof FieldAbsent | typeof EntityAbsent>, false>
>;
type _truthIncompleteHasReason = Expect<
  Extends<{ readonly _tag: "Incomplete"; readonly reason: typeof MissingMe }, Truth>
>;

type MissingRefTarget = {
  readonly id: ReturnType<typeof FieldId>;
  readonly valueType: "ref";
  readonly cardinality: "one";
  readonly optional: false;
  readonly owned: false;
};
type _refTargetRequired = Expect<Equal<Extends<MissingRefTarget, FieldDescriptor>, false>>;

type RefFieldWithTarget = {
  readonly id: ReturnType<typeof FieldId>;
  readonly valueType: "ref";
  readonly refTarget: { readonly _tag: "entity"; readonly entity: ReturnType<typeof EntityId> };
  readonly cardinality: "one";
  readonly optional: false;
  readonly owned: false;
};
type _refTargetPreserved = Expect<Extends<RefFieldWithTarget, FieldDescriptor>>;

type _missingMeIsProjected = Expect<Extends<typeof MissingMeProjection, Projected>>;
type _missingMeIsIncomplete = Expect<
  Extends<typeof MissingMeProjection, IncompleteProjected>
>;
type _missingMeIsNotComplete = Expect<
  Equal<Extends<typeof MissingMeProjection, CompleteProjected>, false>
>;
type _missingMeIsNotEntityAbsent = Expect<
  Equal<Extends<typeof MissingMeProjection, typeof EntityAbsent>, false>
>;

type _presentUndefinedNever = Expect<Equal<PresentType<undefined>, never>>;
type _presentOptionalNever = Expect<Equal<PresentType<string | undefined>, never>>;
type _presentScalarOk = Expect<Extends<PresentType<string>, Projected>>;

type FlatScalarInput = {
  readonly key: "labels";
  readonly valueType: "string";
  readonly cardinality: "many";
  readonly optional: false;
};
type _flatInputRejected = Expect<
  Equal<Extends<FlatScalarInput, OperationInputFieldDescriptor>, false>
>;

type NestedArrayStructInput = {
  readonly key: "labels";
  readonly optional: false;
  readonly shape: {
    readonly _tag: "array";
    readonly items: {
      readonly _tag: "struct";
      readonly fields: readonly [
        {
          readonly key: "name";
          readonly optional: false;
          readonly shape: { readonly _tag: "scalar"; readonly valueType: "string" };
        },
      ];
    };
  };
};
type _nestedInputPreserved = Expect<
  Extends<NestedArrayStructInput, OperationInputFieldDescriptor>
>;

type FailureTags = AuthorizationFailure["_tag"];
type _allFailures = Expect<
  Equal<
    FailureTags,
    | "InvalidIR"
    | "CatalogMismatch"
    | "IncompleteRuleSnapshot"
    | "AuthorizationBudgetExceeded"
    | "LeaseExpired"
    | "AuthorizationDenied"
  >
>;

const templateFixture: PolicyTemplateIR = {
  _tag: "PolicyTemplateIR",
  version: POLICY_TEMPLATE_IR_VERSION,
  classes: [],
  claims: ["org"],
  principal: {
    subjectClaim: "sub",
    entity: RelativeFieldId({ kind: "entity", name: "user" }, "authId"),
  },
  rules: [
    {
      id: RuleId("owns-issue"),
      focus: { _tag: "entity", entity: { _tag: "RelativeEntityId", name: "issue" } },
      expr: {
        _tag: "eq",
        left: {
          _tag: "ref",
          root: { _tag: "resource" },
          steps: [{ field: RelativeFieldId(issueOwner, "owner") }],
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
      id: RuleId("rename-input"),
      focus: {
        _tag: "operation",
        operation: RelativeOperationId(issueOwner, "rename", "required"),
      },
      expr: {
        _tag: "and",
        exprs: [
          { _tag: "hasClass", class: "member" },
          { _tag: "has", term: { _tag: "input", key: "title" } },
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
      id: RuleId("tag-grant"),
      focus: { _tag: "trait", trait: { _tag: "RelativeTraitId", name: "taggable" } },
      expr: {
        _tag: "some",
        collection: {
          _tag: "ref",
          root: { _tag: "resource" },
          steps: [{ field: RelativeFieldId(taggableOwner, "tags") }],
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
                  steps: [{ field: RelativeFieldId({ kind: "entity", name: "tag-grant" }, "user") }],
                },
                right: { _tag: "me" },
              },
              {
                _tag: "eq",
                left: {
                  _tag: "ref",
                  root: { _tag: "bind", name: "grant" },
                  steps: [{ field: RelativeFieldId({ kind: "entity", name: "tag-grant" }, "tag") }],
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
        decision: { allow: [RuleId("owns-issue")], deny: [] },
      },
    ],
    traits: [
      {
        target: { _tag: "RelativeTraitId", name: "taggable" },
        decision: { allow: [RuleId("tag-grant")], deny: [] },
      },
    ],
    fields: [],
    operations: [
      {
        target: RelativeOperationId(issueOwner, "rename", "required"),
        decision: { allow: [RuleId("rename-input")], deny: [] },
      },
      {
        target: RelativeOperationId(issueOwner, "create", "none"),
        decision: { allow: [RuleId("rename-input")], deny: [] },
      },
    ],
  },
};

const installedFixture: InstalledAuthorizationIR = {
  _tag: "InstalledAuthorizationIR",
  version: INSTALLED_AUTHORIZATION_IR_VERSION,
  database: DatabaseId("todos"),
  catalog,
  catalogVersion: CatalogVersion("1"),
  schemaFingerprint: SchemaFingerprint("schema"),
  policyHash: PolicyHash("policy"),
  classes: ["member"],
  claims: ["org"],
  principal: {
    subjectClaim: "sub",
    entity: FieldId(catalog, { kind: "entity", name: "user" }, "authId"),
  },
  identities: {
    entities: [EntityId(catalog, "issue")],
    traits: [TraitId(catalog, "taggable")],
    fields: [FieldId(catalog, issueOwner, "owner")],
    operations: [
      OperationId(catalog, issueOwner, "rename", "required"),
      OperationId(catalog, issueOwner, "create", "none"),
      OperationId(catalog, taggableOwner, "addTag", "required"),
    ],
  },
  traitComposition: [
    {
      composer: EntityId(catalog, "issue"),
      trait: TraitId(catalog, "taggable"),
      transitive: [TraitId(catalog, "taggable")],
    },
  ],
  operations: [
    {
      id: OperationId(catalog, issueOwner, "rename", "required"),
      input: {
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
      id: OperationId(catalog, issueOwner, "create", "none"),
      input: {
        fields: [
          {
            key: "title",
            optional: false,
            shape: { _tag: "scalar", valueType: "string" },
          },
          {
            key: "labels",
            optional: true,
            shape: {
              _tag: "array",
              items: {
                _tag: "struct",
                fields: [
                  {
                    key: "name",
                    optional: false,
                    shape: { _tag: "scalar", valueType: "string" },
                  },
                ],
              },
            },
          },
        ],
      },
    },
  ],
  rules: [],
  decisions: { entities: [], traits: [], fields: [], operations: [] },
  accessPlans: [],
};

const catalogDescriptor: CatalogDescriptor = {
  id: catalog,
  version: CatalogVersion("1"),
  fingerprint: SchemaFingerprint("schema"),
  entities: [{ id: EntityId(catalog, "issue"), traits: [TraitId(catalog, "taggable")] }],
  traits: [{ id: TraitId(catalog, "taggable"), traits: [] }],
  fields: [
    {
      id: FieldId(catalog, issueOwner, "owner"),
      valueType: "ref",
      refTarget: { _tag: "entity", entity: EntityId(catalog, "user") },
      cardinality: "one",
      optional: false,
      owned: false,
    },
  ],
  operations: installedFixture.operations,
  traitComposition: installedFixture.traitComposition,
};

const bindingInput: CatalogBindingInput = {
  catalog: catalogDescriptor,
  template: templateFixture,
};

const _operationFixtures = () => {
  const ownedTargetless: OperationIdType = OperationId(catalog, issueOwner, "create", "none");
  const traitOwned: OperationIdType = OperationId(catalog, taggableOwner, "addTag", "required");

  // @ts-expect-error — owner cannot be omitted
  const noOwner: OperationIdType = {
    _tag: "OperationId",
    catalog,
    localName: "create",
    target: "none",
  };

  // @ts-expect-error — target cannot be omitted or inferred from owner
  const noTarget: OperationIdType = {
    _tag: "OperationId",
    catalog,
    owner: issueOwner,
    localName: "create",
  };

  // @ts-expect-error — a template is not installed IR
  const asInstalled: InstalledAuthorizationIR = templateFixture;

  // @ts-expect-error — installed IR is not a template
  const asTemplate: PolicyTemplateIR = installedFixture;

  const ownerHop: FieldDescriptor = {
    id: FieldId(catalog, issueOwner, "owner"),
    valueType: "ref",
    refTarget: { _tag: "entity", entity: EntityId(catalog, "user") },
    cardinality: "one",
    optional: false,
    owned: false,
  };

  // @ts-expect-error — ref fields must name the referenced entity/trait
  const ownerWithoutTarget: FieldDescriptor = {
    id: FieldId(catalog, issueOwner, "owner"),
    valueType: "ref",
    cardinality: "one",
    optional: false,
    owned: false,
  };

  const nestedLabels: OperationInputFieldDescriptor = {
    key: "labels",
    optional: false,
    shape: {
      _tag: "array",
      items: {
        _tag: "struct",
        fields: [
          {
            key: "name",
            optional: false,
            shape: { _tag: "scalar", valueType: "string" },
          },
        ],
      },
    },
  };

  const flattenedLabels = {
    key: "labels",
    valueType: "string",
    cardinality: "many",
    optional: false,
  };
  // @ts-expect-error — nested input is not a single storage scalar
  const flattenedAsInput: OperationInputFieldDescriptor = flattenedLabels;

  // @ts-expect-error — Present cannot hold undefined
  const presentUndefined = Present(undefined);

  return {
    ownedTargetless,
    traitOwned,
    noOwner,
    noTarget,
    asInstalled,
    asTemplate,
    ownerHop,
    ownerWithoutTarget,
    nestedLabels,
    flattenedLabels,
    flattenedAsInput,
    presentUndefined,
  };
};

test("authorization type fixtures compile", () => {
  void _operationFixtures;
  void bindingInput;
  expect(True._tag).toBe("True");
  expect(False._tag).toBe("False");
  expect(Incomplete(NotLoaded)._tag).toBe("Incomplete");
  expect(Present(1)._tag).toBe("Present");
  expect(() => Present(undefined as never)).toThrow(/Present cannot hold undefined/);
  expect(FieldAbsent._tag).toBe("FieldAbsent");
  expect(EntityAbsent._tag).toBe("EntityAbsent");
  expect(MissingMeProjection._tag).toBe("MissingMe");
  expect(MissingMe._tag).toBe("MissingMe");
  expect(InvalidTraversal._tag).toBe("InvalidTraversal");
  expect(BudgetExhausted._tag).toBe("BudgetExhausted");
  expect(MAX_TRAVERSAL_DEPTH).toBe(3);
  expect(MAX_EXISTS_DEPTH).toBe(3);
  expect(MAX_READ_LEASE_MS).toBe(5_000);
  expect(DEFAULT_AUTHORIZATION_BUDGET).toBeGreaterThan(0);
  expect(new InvalidIR({ message: "bad" })._tag).toBe("InvalidIR");
  expect(new CatalogMismatch({ message: "stale" })._tag).toBe("CatalogMismatch");
  expect(
    new IncompleteRuleSnapshot({ message: "gap", reason: NotLoaded })._tag,
  ).toBe("IncompleteRuleSnapshot");
  expect(
    new AuthorizationBudgetExceeded({ message: "over", spent: 2, limit: 1 })._tag,
  ).toBe("AuthorizationBudgetExceeded");
  expect(new LeaseExpired({ message: "lease" })._tag).toBe("LeaseExpired");
  expect(new AuthorizationDenied({})._tag).toBe("AuthorizationDenied");
});
