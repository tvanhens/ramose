/**
 * Type-level fixtures for the authorization identity / IR vocabulary.
 *
 * `bun run typecheck` compiles this file. A mismatch turns `Expect<Equal<…>>`
 * into a type error, or leaves a `@ts-expect-error` unused.
 */

// @effect-diagnostics unnecessaryTypeofType:off
// `Expect<Equal<X, typeof X.Type>>` is the assertion: it pins the
// hand-written branded type to the one the schema derives. Rewriting
// `typeof X.Type` to `X` as the rule suggests would collapse each of
// these to `Equal<X, X>` — vacuously true, and testing nothing.

import { describe, expect, test } from "bun:test";
import * as Schema from "effect/Schema";
import type { Equal, Expect, Extends } from "../../../src/db/equal.ts";
import {
  AuthorizationDenied,
  AuthorizationBudgetExceeded,
  BudgetExhausted,
  CatalogId,
  CatalogMismatch,
  CatalogUnitCorrupt,
  CatalogUnitHash,
  CatalogVersion,
  DatabaseId,
  AUTHORIZATION_LANGUAGE_VERSION,
  DEFAULT_AUTHORIZATION_BUDGET,
  EntityAbsent,
  EntityId,
  False,
  FieldAbsent,
  FieldId,
  Incomplete,
  INSTALLED_AUTHORIZATION_IR_VERSION,
  INSTALLED_CATALOG_UNIT_VERSION,
  BOUND_AUTHORIZATION_IR_VERSION,
  VALIDATED_AUTHORIZATION_IR_VERSION,
  InvalidIR,
  InvalidTraversal,
  AUTHORIZATION_CANONICAL_JSON_VERSION,
  DigestHex,
  MAX_COLLECTION_SIZE,
  MAX_JSON_DEPTH,
  MAX_JSON_ENCODED_BYTES,
  MAX_JSON_NODES,
  MAX_READ_LEASE_MS,
  MAX_STRING_LENGTH,
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
  AuthorizationPrincipal,
  AuthorizationValidationInput,
  BoundAuthorizationIR,
  CatalogBindingInput,
  CatalogBindingTarget,
  type CatalogDescriptor,
  ClaimDescriptor,
  type ClaimVocabulary,
  type CompleteProjected,
  FieldDescriptor,
  type IncompleteProjected,
  JsonScalar,
  decodeInstalledAuthorizationResult,
  decodeInstalledCatalogUnitResult,
  InstalledAuthorizationIR,
  InstalledCatalogUnit,
  type InstalledAuthorizationIRV1,
  type InstalledCatalogUnitV1,
  type OperationId as OperationIdType,
  type OperationInputFieldDescriptor,
  OperationInputShape,
  PolicyTemplateIR,
  type RelativeAuthorizationExpr,
  type RelativeValueTerm,
  ValidatedAuthorizationIR,
  type Present as PresentType,
  type Projected,
  type ProjectedValue,
  type RelativeOperationId as RelativeOperationIdType,
  type Truth,
} from "../../../src/internal/authorization/index.ts";
import {
  POLICY_HASH_PLACEHOLDER,
  RULE_HAS_TAG,
  RULE_OWNS_ISSUE,
  RULE_TENANT,
} from "./fixtures.ts";

// @ts-expect-error — not a public package export yet
import type { PolicyTemplateIR as _PublicTemplate } from "ramose";
// @ts-expect-error — not a public package export yet
import type { InstalledAuthorizationIR as _PublicInstalled } from "ramose/db";
// @ts-expect-error — not a public package export yet
import type { InstalledCatalogUnit as _PublicCatalogUnit } from "ramose";
// @ts-expect-error — not a public package export yet
import type { InstalledCatalogUnit as _PublicCatalogUnitDb } from "ramose/db";

type PublicKeys = keyof typeof import("ramose");
export type _noPublicAuthorization = Expect<
  Equal<
    Extract<
      PublicKeys,
      | "Authorization"
      | "PolicyTemplateIR"
      | "BoundAuthorizationIR"
      | "ValidatedAuthorizationIR"
      | "InstalledAuthorizationIR"
      | "decodePolicyTemplate"
      | "decodeInstalledAuthorization"
      | "bindPolicyTemplate"
      | "bindAgainstAuthoritativeCatalog"
      | "validateBoundAuthorization"
      | "installAuthorization"
      | "installAgainstAuthoritativeCatalog"
      | "InstalledAuthorizationIRV1"
      | "InstalledCatalogUnit"
      | "InstalledCatalogUnitV1"
      | "sealInstalledCatalogUnit"
      | "assembleInstalledCatalogUnit"
      | "verifyInstalledCatalogUnit"
      | "requireUnitCoherence"
      | "CatalogUnitCorrupt"
      | "CatalogUnitHash"
    >,
    never
  >
>;

const catalog = CatalogId.make("app");
const issueOwner = { kind: "entity" as const, name: "issue" };
const taggableOwner = { kind: "trait" as const, name: "taggable" };

export type _catalogIdFromSchema = Expect<Equal<CatalogId, typeof CatalogId.Type>>;
export type _databaseIdFromSchema = Expect<Equal<DatabaseId, typeof DatabaseId.Type>>;
export type _catalogVersionFromSchema = Expect<Equal<CatalogVersion, typeof CatalogVersion.Type>>;
export type _schemaFingerprintFromSchema = Expect<Equal<SchemaFingerprint, typeof SchemaFingerprint.Type>>;
export type _digestHexFromSchema = Expect<Equal<DigestHex, typeof DigestHex.Type>>;
export type _policyHashFromSchema = Expect<Equal<PolicyHash, typeof PolicyHash.Type>>;
export type _catalogUnitHashFromSchema = Expect<Equal<CatalogUnitHash, typeof CatalogUnitHash.Type>>;
export type _ruleIdFromSchema = Expect<Equal<RuleId, typeof RuleId.Type>>;
export type _entityIdFromSchema = Expect<Equal<EntityId, typeof EntityId.Type>>;
export type _traitIdFromSchema = Expect<Equal<TraitId, typeof TraitId.Type>>;
export type _fieldIdFromSchema = Expect<Equal<FieldId, typeof FieldId.Type>>;
export type _operationIdFromSchema = Expect<Equal<OperationIdType, typeof OperationId.Type>>;
export type _relativeFieldFromSchema = Expect<Equal<RelativeFieldId, typeof RelativeFieldId.Type>>;
export type _relativeOpFromSchema = Expect<Equal<RelativeOperationIdType, typeof RelativeOperationId.Type>>;
export type _templateFromSchema = Expect<Equal<PolicyTemplateIR, typeof PolicyTemplateIR.Type>>;
export type _boundFromSchema = Expect<Equal<BoundAuthorizationIR, typeof BoundAuthorizationIR.Type>>;
export type _validatedFromSchema = Expect<
  Equal<ValidatedAuthorizationIR, typeof ValidatedAuthorizationIR.Type>
>;
export type _installedFromSchema = Expect<Equal<InstalledAuthorizationIR, typeof InstalledAuthorizationIR.Type>>;
export type _catalogUnitFromSchema = Expect<Equal<InstalledCatalogUnit, typeof InstalledCatalogUnit.Type>>;
export type _structuralNotVerified = Expect<
  Equal<Extends<InstalledAuthorizationIR, InstalledAuthorizationIRV1>, false>
>;
export type _verifiedIsStructural = Expect<Extends<InstalledAuthorizationIRV1, InstalledAuthorizationIR>>;
export type _catalogUnitStructuralNotVerified = Expect<
  Equal<Extends<InstalledCatalogUnit, InstalledCatalogUnitV1>, false>
>;
export type _catalogUnitVerifiedIsStructural = Expect<
  Extends<InstalledCatalogUnitV1, InstalledCatalogUnit>
>;
type DecodedInstalled = Extract<
  ReturnType<typeof decodeInstalledAuthorizationResult>,
  { readonly _tag: "Success" }
>["success"];
export type _decodeIsStructural = Expect<Equal<DecodedInstalled, InstalledAuthorizationIR>>;
export type _decodeNotVerified = Expect<
  Equal<Extends<DecodedInstalled, InstalledAuthorizationIRV1>, false>
>;
type DecodedCatalogUnit = Extract<
  ReturnType<typeof decodeInstalledCatalogUnitResult>,
  { readonly _tag: "Success" }
>["success"];
export type _decodeUnitIsStructural = Expect<Equal<DecodedCatalogUnit, InstalledCatalogUnit>>;
export type _decodeUnitNotVerified = Expect<
  Equal<Extends<DecodedCatalogUnit, InstalledCatalogUnitV1>, false>
>;
export type _validationInputFromSchema = Expect<
  Equal<AuthorizationValidationInput, typeof AuthorizationValidationInput.Type>
>;
export type _bindingFromSchema = Expect<Equal<CatalogBindingInput, typeof CatalogBindingInput.Type>>;
export type _bindingTargetFromSchema = Expect<
  Equal<CatalogBindingTarget, typeof CatalogBindingTarget.Type>
>;
export type _fieldFromSchema = Expect<Equal<FieldDescriptor, typeof FieldDescriptor.Type>>;
export type _inputFromSchema = Expect<Equal<OperationInputShape, typeof OperationInputShape.Type>>;
export type _claimFromSchema = Expect<Equal<ClaimDescriptor, typeof ClaimDescriptor.Type>>;
export type _principalFromSchema = Expect<Equal<AuthorizationPrincipal, typeof AuthorizationPrincipal.Type>>;

type TemplateEncoded = typeof PolicyTemplateIR.Encoded;
type InstalledEncoded = typeof InstalledAuthorizationIR.Encoded;
type CatalogUnitEncoded = typeof InstalledCatalogUnit.Encoded;
export type _templateEncodedKnown = Expect<Extends<TemplateEncoded, { readonly _tag: "PolicyTemplateIR" }>>;
export type _installedEncodedKnown = Expect<
  Extends<InstalledEncoded, { readonly _tag: "InstalledAuthorizationIR" }>
>;
export type _catalogUnitEncodedKnown = Expect<
  Extends<CatalogUnitEncoded, { readonly _tag: "InstalledCatalogUnit" }>
>;
export type _templateEncodedNotUnknown = Expect<Equal<Extends<unknown, TemplateEncoded>, false>>;
export type _installedEncodedNotUnknown = Expect<Equal<Extends<unknown, InstalledEncoded>, false>>;
export type _installedCatalogDecoded = Expect<Equal<InstalledAuthorizationIR["catalog"], CatalogId>>;
export type _installedCatalogEncoded = Expect<Equal<InstalledEncoded["catalog"], string>>;
export type _jsonValueEncoded = Expect<Equal<typeof JsonScalar.Encoded, JsonScalar>>;

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

export type _ownerRequired = Expect<Equal<Extends<OwnerlessOperation, OperationIdType>, false>>;
export type _targetRequired = Expect<Equal<Extends<TargetOmittedOperation, OperationIdType>, false>>;
export type _ownerAndTargetIndependent = Expect<Equal<Extends<OwnerAsTarget, OperationIdType>, false>>;

type TargetlessOwned = {
  readonly _tag: "OperationId";
  readonly catalog: typeof catalog;
  readonly owner: typeof issueOwner;
  readonly localName: "create";
  readonly target: "none";
};
export type _targetNoneWithOwner = Expect<Extends<TargetlessOwned, OperationIdType>>;

type TraitTargeted = {
  readonly _tag: "OperationId";
  readonly catalog: typeof catalog;
  readonly owner: typeof taggableOwner;
  readonly localName: "addTag";
  readonly target: "required";
};
export type _traitOwnerSupported = Expect<Extends<TraitTargeted, OperationIdType>>;

type RelativeOwnerless = {
  readonly _tag: "RelativeOperationId";
  readonly localName: "create";
  readonly target: "none";
};
export type _relativeOwnerRequired = Expect<
  Equal<Extends<RelativeOwnerless, RelativeOperationIdType>, false>
>;

export type _templateNotInstalled = Expect<
  Equal<Extends<PolicyTemplateIR, InstalledAuthorizationIR>, false>
>;
export type _installedNotTemplate = Expect<
  Equal<Extends<InstalledAuthorizationIR, PolicyTemplateIR>, false>
>;
export type _templateNotBound = Expect<
  Equal<Extends<PolicyTemplateIR, BoundAuthorizationIR>, false>
>;
export type _boundNotTemplate = Expect<
  Equal<Extends<BoundAuthorizationIR, PolicyTemplateIR>, false>
>;
export type _boundNotInstalled = Expect<
  Equal<Extends<BoundAuthorizationIR, InstalledAuthorizationIR>, false>
>;
export type _installedNotBound = Expect<
  Equal<Extends<InstalledAuthorizationIR, BoundAuthorizationIR>, false>
>;
export type _boundNotValidated = Expect<
  Equal<Extends<BoundAuthorizationIR, ValidatedAuthorizationIR>, false>
>;
export type _validatedNotBound = Expect<
  Equal<Extends<ValidatedAuthorizationIR, BoundAuthorizationIR>, false>
>;
export type _validatedNotInstalled = Expect<
  Equal<Extends<ValidatedAuthorizationIR, InstalledAuthorizationIR>, false>
>;
export type _installedNotValidated = Expect<
  Equal<Extends<InstalledAuthorizationIR, ValidatedAuthorizationIR>, false>
>;
export type _templateNotValidated = Expect<
  Equal<Extends<PolicyTemplateIR, ValidatedAuthorizationIR>, false>
>;

type PartialBound = Pick<BoundAuthorizationIR, "rules" | "decisions" | "principal">;
export type _partialBoundNotInstalled = Expect<
  Equal<Extends<PartialBound, InstalledAuthorizationIR>, false>
>;
type UnhashedInstalledTables = Omit<InstalledAuthorizationIR, "_tag" | "policyHash">;
export type _unhashedTablesNotInstalled = Expect<
  Equal<Extends<UnhashedInstalledTables, InstalledAuthorizationIRV1>, false>
>;
export type _unhashedTablesNotInstalledAlias = Expect<
  Equal<Extends<UnhashedInstalledTables, InstalledAuthorizationIR>, false>
>;
type AuthExports = typeof import("../../../src/internal/authorization/index.ts");
export type _noPureAssembleExport = Expect<
  Equal<Extends<"assembleUnhashedTables" | "assembleInstalledAuthorizationResult", keyof AuthExports>, false>
>;
export type _catalogUnitOnBarrel = Expect<Extends<"InstalledCatalogUnit", keyof AuthExports>>;
export type _sealCatalogUnitOnBarrel = Expect<Extends<"sealInstalledCatalogUnit", keyof AuthExports>>;
export type _partialBoundNotTemplate = Expect<
  Equal<Extends<PartialBound, PolicyTemplateIR>, false>
>;

type PrincipalWithoutSubject = {
  readonly claims: {};
  readonly classes: readonly [];
};
export type _subjectRequired = Expect<
  Equal<Extends<PrincipalWithoutSubject, AuthorizationPrincipal>, false>
>;

type ServicePrincipal = {
  readonly subject: "svc";
  readonly claims: {};
  readonly classes: readonly [];
};
export type _meOptional = Expect<Extends<ServicePrincipal, AuthorizationPrincipal>>;
export type _emptyClassesAllowed = Expect<Extends<ServicePrincipal, AuthorizationPrincipal>>;

export type _absentIsNotUndefined = Expect<
  Equal<Extends<undefined, Projected>, false>
>;
export type _incompleteIsNotPresent = Expect<
  Equal<Extends<IncompleteProjected, typeof FieldAbsent | typeof EntityAbsent>, false>
>;
export type _truthIncompleteHasReason = Expect<
  Extends<{ readonly _tag: "Incomplete"; readonly reason: typeof MissingMe }, Truth>
>;

type MissingRefTarget = {
  readonly id: FieldId;
  readonly valueType: "ref";
  readonly cardinality: "one";
  readonly optional: false;
  readonly owned: false;
};
export type _refTargetRequired = Expect<Equal<Extends<MissingRefTarget, FieldDescriptor>, false>>;

type RefFieldWithTarget = {
  readonly id: FieldId;
  readonly valueType: "ref";
  readonly refTarget: { readonly _tag: "entity"; readonly entity: EntityId };
  readonly cardinality: "one";
  readonly index: true;
  readonly optional: false;
  readonly owned: false;
};
export type _refTargetPreserved = Expect<Extends<RefFieldWithTarget, FieldDescriptor>>;

type IndexedFieldMissingFlag = {
  readonly id: FieldId;
  readonly valueType: "string";
  readonly cardinality: "one";
  readonly optional: false;
  readonly owned: false;
};
export type _indexRequired = Expect<Equal<Extends<IndexedFieldMissingFlag, FieldDescriptor>, false>>;

export type _missingMeIsProjected = Expect<Extends<typeof MissingMeProjection, Projected>>;
export type _missingMeIsIncomplete = Expect<
  Extends<typeof MissingMeProjection, IncompleteProjected>
>;
export type _missingMeIsNotComplete = Expect<
  Equal<Extends<typeof MissingMeProjection, CompleteProjected>, false>
>;
export type _missingMeIsNotEntityAbsent = Expect<
  Equal<Extends<typeof MissingMeProjection, typeof EntityAbsent>, false>
>;

export type _presentUndefinedNever = Expect<Equal<PresentType<undefined>, never>>;
export type _presentOptionalNever = Expect<Equal<PresentType<string | undefined>, never>>;
export type _presentScalarOk = Expect<Extends<PresentType<string>, Projected>>;
export type _presentInstantOk = Expect<Extends<PresentType<Date>, Projected>>;
export type _presentBytesOk = Expect<Extends<PresentType<Uint8Array>, Projected>>;
export type _presentManyOk = Expect<Extends<PresentType<readonly number[]>, Projected>>;
export type _projectedValueCoversStorage = Expect<
  Extends<Date | Uint8Array | readonly string[], ProjectedValue>
>;

type KeyOnlyClaims = readonly ["teams"];
export type _claimKeysRejected = Expect<Equal<Extends<KeyOnlyClaims, ClaimVocabulary>, false>>;

type TeamsClaim = {
  readonly key: "teams";
  readonly optional: false;
  readonly shape: {
    readonly _tag: "array";
    readonly items: { readonly _tag: "scalar"; readonly valueType: "string" };
  };
};
export type _claimShapePreserved = Expect<Extends<TeamsClaim, ClaimDescriptor>>;

type StructOnlyInput = {
  readonly fields: readonly OperationInputFieldDescriptor[];
};
export type _topLevelFieldsRejected = Expect<
  Equal<Extends<StructOnlyInput, OperationInputShape>, false>
>;
export type _topLevelArrayOk = Expect<
  Extends<{ readonly _tag: "array"; readonly items: { readonly _tag: "opaque" } }, OperationInputShape>
>;
export type _topLevelOpaqueOk = Expect<Extends<{ readonly _tag: "opaque" }, OperationInputShape>>;

type DeferredInputTerm = { readonly _tag: "input"; readonly path: readonly ["title"] };
export type _inputTermRejected = Expect<Equal<Extends<DeferredInputTerm, RelativeValueTerm>, false>>;
type DeferredBindTerm = { readonly _tag: "bind"; readonly name: "tag" };
export type _bindTermRejected = Expect<Equal<Extends<DeferredBindTerm, RelativeValueTerm>, false>>;
type DeferredSome = {
  readonly _tag: "some";
  readonly collection: never;
  readonly bind: "tag";
  readonly pred: RelativeAuthorizationExpr;
};
export type _someRejected = Expect<Equal<Extends<DeferredSome, RelativeAuthorizationExpr>, false>>;
type DeferredExists = {
  readonly _tag: "exists";
  readonly entity: { readonly _tag: "RelativeEntityId"; readonly name: "issue" };
  readonly bind: "row";
  readonly pred: RelativeAuthorizationExpr;
};
export type _existsRejected = Expect<Equal<Extends<DeferredExists, RelativeAuthorizationExpr>, false>>;
type DeferredOverlaps = {
  readonly _tag: "overlaps";
  readonly left: never;
  readonly right: never;
};
export type _overlapsRejected = Expect<Equal<Extends<DeferredOverlaps, RelativeAuthorizationExpr>, false>>;
type OperationFocus = {
  readonly _tag: "operation";
  readonly operation: RelativeOperationIdType;
};
export type _operationFocusRejected = Expect<
  Equal<Extends<OperationFocus, PolicyTemplateIR["rules"][number]["focus"]>, false>
>;

type BindingWithoutDatabase = {
  readonly descriptor: CatalogDescriptor;
  readonly template: PolicyTemplateIR;
};
export type _databaseRequiredOnBind = Expect<
  Equal<Extends<BindingWithoutDatabase, CatalogBindingInput>, false>
>;
type BindingWithoutTarget = {
  readonly descriptor: CatalogDescriptor;
  readonly template: PolicyTemplateIR;
};
export type _targetRequiredOnBind = Expect<
  Equal<Extends<BindingWithoutTarget, CatalogBindingInput>, false>
>;

type FlatScalarInput = {
  readonly key: "labels";
  readonly valueType: "string";
  readonly cardinality: "many";
  readonly optional: false;
};
export type _flatInputRejected = Expect<
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
export type _nestedInputPreserved = Expect<
  Extends<NestedArrayStructInput, OperationInputFieldDescriptor>
>;

type FailureTags = AuthorizationFailure["_tag"];
export type _allFailures = Expect<
  Equal<
    FailureTags,
    | "InvalidIR"
    | "CatalogMismatch"
    | "AuthorizationBudgetExceeded"
    | "AuthorizationDenied"
  >
>;
export type _catalogUnitCorruptNotAuthorizationFailure = Expect<
  Equal<Extends<"CatalogUnitCorrupt", FailureTags>, false>
>;

const templateFixture: PolicyTemplateIR = {
  _tag: "PolicyTemplateIR",
  version: POLICY_TEMPLATE_IR_VERSION,
  languageVersion: AUTHORIZATION_LANGUAGE_VERSION,
  classes: [],
  claims: [
    {
      key: "org",
      optional: false,
      shape: { _tag: "scalar", valueType: "string" },
    },
    {
      key: "teams",
      optional: true,
      shape: {
        _tag: "array",
        items: { _tag: "scalar", valueType: "string" },
      },
    },
  ],
  principal: {
    subjectClaim: "sub",
    entity: RelativeFieldId.make({ owner: { kind: "entity", name: "user" }, localName: "authId" }),
  },
  rules: [
    {
      id: RuleId.make(RULE_OWNS_ISSUE),
      focus: { _tag: "entity", entity: { _tag: "RelativeEntityId", name: "issue" } },
      expr: {
        _tag: "eq",
        left: {
          _tag: "ref",
          root: { _tag: "resource" },
          steps: [{ field: RelativeFieldId.make({ owner: issueOwner, localName: "owner" }) }],
        },
        right: { _tag: "me" },
      },
      usesResource: true,
      usesMe: true,
      usesSubject: false,
      traversalDepth: 1,
    },
    {
      id: RuleId.make(RULE_TENANT),
      focus: { _tag: "entity", entity: { _tag: "RelativeEntityId", name: "issue" } },
      expr: {
        _tag: "and",
        exprs: [
          { _tag: "hasClass", class: "member" },
          { _tag: "eq", left: { _tag: "subject" }, right: { _tag: "claim", key: "org" } },
        ],
      },
      usesResource: false,
      usesMe: false,
      usesSubject: true,
      traversalDepth: 0,
    },
    {
      id: RuleId.make(RULE_HAS_TAG),
      focus: { _tag: "trait", trait: { _tag: "RelativeTraitId", name: "taggable" } },
      expr: {
        _tag: "in",
        value: { _tag: "me" },
        collection: {
          _tag: "ref",
          root: { _tag: "resource" },
          steps: [{ field: RelativeFieldId.make({ owner: taggableOwner, localName: "tags" }) }],
        },
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
        decision: { allow: [RuleId.make(RULE_OWNS_ISSUE), RuleId.make(RULE_TENANT)], deny: [] },
      },
    ],
    traits: [
      {
        target: { _tag: "RelativeTraitId", name: "taggable" },
        decision: { allow: [RuleId.make(RULE_HAS_TAG)], deny: [] },
      },
    ],
    fields: [],
  },
};

const installedFixture: InstalledAuthorizationIR = {
  _tag: "InstalledAuthorizationIR",
  version: INSTALLED_AUTHORIZATION_IR_VERSION,
  languageVersion: AUTHORIZATION_LANGUAGE_VERSION,
  database: DatabaseId.make("todos"),
  catalog,
  catalogVersion: CatalogVersion.make("1"),
  schemaFingerprint: SchemaFingerprint.make("schema"),
  policyHash: PolicyHash.make(POLICY_HASH_PLACEHOLDER),
  classes: ["member"],
  claims: [
    {
      key: "org",
      optional: false,
      shape: { _tag: "scalar", valueType: "string" },
    },
    {
      key: "teams",
      optional: true,
      shape: {
        _tag: "array",
        items: { _tag: "scalar", valueType: "string" },
      },
    },
  ],
  principal: {
    subjectClaim: "sub",
    entity: FieldId.make({ catalog, owner: { kind: "entity", name: "user" }, localName: "authId" }),
  },
  identities: {
    entities: [EntityId.make({ catalog, name: "issue" })],
    traits: [TraitId.make({ catalog, name: "taggable" })],
    fields: [FieldId.make({ catalog, owner: issueOwner, localName: "owner" })],
    operations: [
      OperationId.make({ catalog, owner: issueOwner, localName: "rename", target: "required" }),
      OperationId.make({ catalog, owner: issueOwner, localName: "create", target: "none" }),
      OperationId.make({ catalog, owner: taggableOwner, localName: "addTag", target: "required" }),
    ],
  },
  traitComposition: [
    {
      composer: EntityId.make({ catalog, name: "issue" }),
      trait: TraitId.make({ catalog, name: "taggable" }),
      transitive: [TraitId.make({ catalog, name: "taggable" })],
    },
  ],
  operations: [
    {
      id: OperationId.make({ catalog, owner: issueOwner, localName: "rename", target: "required" }),
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
      id: OperationId.make({ catalog, owner: issueOwner, localName: "create", target: "none" }),
      input: {
        _tag: "array",
        items: {
          _tag: "struct",
          fields: [
            {
              key: "title",
              optional: false,
              shape: { _tag: "scalar", valueType: "string" },
            },
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
  rules: [],
  decisions: { entities: [], traits: [], fields: [] },
  accessPlans: [],
};

const catalogDescriptor: CatalogDescriptor = {
  id: catalog,
  database: DatabaseId.make("todos"),
  version: CatalogVersion.make("1"),
  fingerprint: SchemaFingerprint.make("schema"),
  entities: [{ id: EntityId.make({ catalog, name: "issue" }), traits: [TraitId.make({ catalog, name: "taggable" })] }],
  traits: [{ id: TraitId.make({ catalog, name: "taggable" }), traits: [] }],
  fields: [
    {
      id: FieldId.make({ catalog, owner: issueOwner, localName: "owner" }),
      valueType: "ref",
      refTarget: { _tag: "entity", entity: EntityId.make({ catalog, name: "user" }) },
      cardinality: "one",
      index: false,
      optional: false,
      owned: false,
    },
  ],
  operations: installedFixture.operations,
  traitComposition: installedFixture.traitComposition,
};

const catalogUnitFixture: InstalledCatalogUnit = {
  _tag: "InstalledCatalogUnit",
  version: INSTALLED_CATALOG_UNIT_VERSION,
  languageVersion: AUTHORIZATION_LANGUAGE_VERSION,
  database: DatabaseId.make("todos"),
  catalog,
  catalogVersion: CatalogVersion.make("1"),
  schemaFingerprint: SchemaFingerprint.make("schema"),
  unitHash: CatalogUnitHash.make(POLICY_HASH_PLACEHOLDER),
  entities: catalogDescriptor.entities,
  traits: catalogDescriptor.traits,
  fields: catalogDescriptor.fields,
  traitComposition: catalogDescriptor.traitComposition,
  identities: installedFixture.identities,
  operations: installedFixture.operations,
  policy: installedFixture,
};

const bindingInput: CatalogBindingInput = {
  target: {
    database: DatabaseId.make("todos"),
    catalog,
    catalogVersion: CatalogVersion.make("1"),
    schemaFingerprint: SchemaFingerprint.make("schema"),
  },
  descriptor: catalogDescriptor,
  template: templateFixture,
};

const _operationFixtures = () => {
  const ownedTargetless: OperationIdType = OperationId.make({
    catalog,
    owner: issueOwner,
    localName: "create",
    target: "none",
  });
  const traitOwned: OperationIdType = OperationId.make({
    catalog,
    owner: taggableOwner,
    localName: "addTag",
    target: "required",
  });

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

  // @ts-expect-error — structural document is not verified installed v1
  const structuralAsVerified: InstalledAuthorizationIRV1 = installedFixture;

  // @ts-expect-error — structural catalog unit is not verified installed catalog unit v1
  const structuralUnitAsVerified: InstalledCatalogUnitV1 = catalogUnitFixture;

  // @ts-expect-error — installed IR is not a template
  const asTemplate: PolicyTemplateIR = installedFixture;

  const boundFixture = {
    _tag: "BoundAuthorizationIR" as const,
    version: BOUND_AUTHORIZATION_IR_VERSION,
    database: DatabaseId.make("todos"),
    catalog,
    catalogVersion: CatalogVersion.make("1"),
    schemaFingerprint: SchemaFingerprint.make("schema"),
    classes: [] as const,
    claims: [] as const,
    principal: { subjectClaim: "sub" },
    languageVersion: AUTHORIZATION_LANGUAGE_VERSION,
    rules: [] as const,
    decisions: { entities: [], traits: [], fields: [] },
  } satisfies BoundAuthorizationIR;

  const validatedFixture = {
    ...boundFixture,
    _tag: "ValidatedAuthorizationIR" as const,
    version: VALIDATED_AUTHORIZATION_IR_VERSION,
  } satisfies ValidatedAuthorizationIR;

  // @ts-expect-error — a bound intermediate is not installed IR
  const boundAsInstalled: InstalledAuthorizationIR = boundFixture;

  // @ts-expect-error — a validated intermediate is not installed IR
  const validatedAsInstalled: InstalledAuthorizationIR = validatedFixture;

  // @ts-expect-error — a validated intermediate is not installed v1 IR
  const validatedAsInstalledV1: InstalledAuthorizationIRV1 = validatedFixture;

  const unhashedTables: UnhashedInstalledTables = {
    version: INSTALLED_AUTHORIZATION_IR_VERSION,
    languageVersion: AUTHORIZATION_LANGUAGE_VERSION,
    database: DatabaseId.make("todos"),
    catalog,
    catalogVersion: CatalogVersion.make("1"),
    schemaFingerprint: SchemaFingerprint.make("schema"),
    classes: [],
    claims: [],
    principal: { subjectClaim: "sub" },
    identities: { entities: [], traits: [], fields: [], operations: [] },
    traitComposition: [],
    operations: [],
    rules: [],
    decisions: { entities: [], traits: [], fields: [] },
    accessPlans: [],
  };
  // @ts-expect-error — unhashed tables are not runtime-acceptable installed IR
  const unhashedAsInstalled: InstalledAuthorizationIRV1 = unhashedTables;

  // @ts-expect-error — a bound intermediate is not validated IR
  const boundAsValidated: ValidatedAuthorizationIR = boundFixture;

  // @ts-expect-error — a template is not a bound intermediate
  const templateAsBound: BoundAuthorizationIR = templateFixture;

  const partialBound: Pick<BoundAuthorizationIR, "rules" | "decisions"> = {
    rules: [],
    decisions: { entities: [], traits: [], fields: [] },
  };
  // @ts-expect-error — a partial bound result is not installed IR
  const partialAsInstalled: InstalledAuthorizationIR = partialBound;

  const ownerHop: FieldDescriptor = {
    id: FieldId.make({ catalog, owner: issueOwner, localName: "owner" }),
    valueType: "ref",
    refTarget: { _tag: "entity", entity: EntityId.make({ catalog, name: "user" }) },
    cardinality: "one",
    index: true,
    optional: false,
    owned: false,
  };

  // @ts-expect-error — ref fields must name the referenced entity/trait
  const ownerWithoutTarget: FieldDescriptor = {
    id: FieldId.make({ catalog, owner: issueOwner, localName: "owner" }),
    valueType: "ref",
    cardinality: "one",
    index: false,
    optional: false,
    owned: false,
  };

  const unindexed = {
    id: FieldId.make({ catalog, owner: issueOwner, localName: "title" }),
    valueType: "string" as const,
    cardinality: "one" as const,
    optional: false as const,
    owned: false as const,
  };
  // @ts-expect-error — index is distinct from uniqueness and is required
  const missingIndex: FieldDescriptor = unindexed;

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

  const presentInstant: PresentType<Date> = Present(new Date(0));
  const presentBytes: PresentType<Uint8Array> = Present(new Uint8Array());
  const presentMany: PresentType<readonly string[]> = Present(["a"]);

  const topLevelArray: OperationInputShape = {
    _tag: "array",
    items: { _tag: "opaque" },
  };
  const fieldsOnlyInput = {
    fields: [] as const,
  };
  // @ts-expect-error — top-level input is a shape, not a bare field map
  const asTopLevel: OperationInputShape = fieldsOnlyInput;

  const claimKeys = ["teams"] as const;
  // @ts-expect-error — claim vocabulary stores shapes, not bare keys
  const asClaims: ClaimVocabulary = claimKeys;

  const bindWithoutDb = {
    descriptor: catalogDescriptor,
    template: templateFixture,
  };
  // @ts-expect-error — binding names the target database
  const asBind: CatalogBindingInput = bindWithoutDb;

  return {
    ownedTargetless,
    traitOwned,
    noOwner,
    noTarget,
    asInstalled,
    structuralAsVerified,
    structuralUnitAsVerified,
    asTemplate,
    boundAsInstalled,
    validatedAsInstalled,
    boundAsValidated,
    templateAsBound,
    partialAsInstalled,
    ownerHop,
    ownerWithoutTarget,
    missingIndex,
    nestedLabels,
    flattenedLabels,
    flattenedAsInput,
    presentUndefined,
    presentInstant,
    presentBytes,
    presentMany,
    topLevelArray,
    asTopLevel,
    asClaims,
    asBind,
  };
};

test("authorization type fixtures compile", () => {
  void _operationFixtures;
  void bindingInput;
  expect(True._tag).toBe("True");
  expect(False._tag).toBe("False");
  expect(Incomplete(NotLoaded)._tag).toBe("Incomplete");
  expect(Present(1)._tag).toBe("Present");
  expect(Present(new Date(0)).value).toBeInstanceOf(Date);
  expect(Present(new Uint8Array([1])).value).toBeInstanceOf(Uint8Array);
  expect(() => Present(undefined as never)).toThrow(/Present cannot hold undefined/);
  expect(FieldAbsent._tag).toBe("FieldAbsent");
  expect(EntityAbsent._tag).toBe("EntityAbsent");
  expect(MissingMeProjection._tag).toBe("MissingMe");
  expect(MissingMe._tag).toBe("MissingMe");
  expect(InvalidTraversal._tag).toBe("InvalidTraversal");
  expect(BudgetExhausted._tag).toBe("BudgetExhausted");
  expect(MAX_TRAVERSAL_DEPTH).toBe(3);
  expect(AUTHORIZATION_LANGUAGE_VERSION).toBe("v1");
  expect(MAX_READ_LEASE_MS).toBe(5_000);
  expect(MAX_JSON_DEPTH).toBeGreaterThan(0);
  expect(MAX_COLLECTION_SIZE).toBeGreaterThan(0);
  expect(MAX_STRING_LENGTH).toBeGreaterThan(0);
  expect(MAX_JSON_NODES).toBeGreaterThan(MAX_COLLECTION_SIZE);
  expect(MAX_JSON_ENCODED_BYTES).toBeGreaterThan(MAX_STRING_LENGTH);
  expect(AUTHORIZATION_CANONICAL_JSON_VERSION).toBe("rfc8785-jcs/1");
  expect(Schema.is(RuleId)("owns-issue")).toBe(false);
  expect(Schema.is(PolicyHash)("policy")).toBe(false);
  expect(Schema.is(RuleId)("AA".repeat(32))).toBe(false);
  expect(Schema.is(RuleId)("a".repeat(63))).toBe(false);
  expect(Schema.is(RuleId)(RULE_OWNS_ISSUE)).toBe(true);
  expect(Schema.is(PolicyHash)(POLICY_HASH_PLACEHOLDER)).toBe(true);
  expect(Schema.is(DigestHex)(RULE_OWNS_ISSUE)).toBe(true);
  expect(DEFAULT_AUTHORIZATION_BUDGET).toBeGreaterThan(0);
  expect(new InvalidIR({ message: "bad" })._tag).toBe("InvalidIR");
  expect(new CatalogMismatch({ message: "stale" })._tag).toBe("CatalogMismatch");
  expect(Schema.is(CatalogUnitHash)(POLICY_HASH_PLACEHOLDER)).toBe(true);
  expect(catalogUnitFixture._tag).toBe("InstalledCatalogUnit");
  expect(INSTALLED_CATALOG_UNIT_VERSION).toBe(1);
  expect(new CatalogUnitCorrupt({ message: "bad", catalog })._tag).toBe("CatalogUnitCorrupt");
  expect(
    new AuthorizationBudgetExceeded({ message: "over", spent: 2, limit: 1 })._tag,
  ).toBe("AuthorizationBudgetExceeded");
  expect(new AuthorizationDenied()._tag).toBe("AuthorizationDenied");
  // @ts-expect-error — denial carries no diagnostic payload
  new AuthorizationDenied({ message: "exists" });
  expect(Object.getPrototypeOf(templateFixture)).toBe(Object.prototype);
  expect(Object.getPrototypeOf(installedFixture)).toBe(Object.prototype);
  expect(Schema.is(JsonScalar)(1)).toBe(true);
  expect(Schema.is(JsonScalar)(Number.NaN)).toBe(false);
  expect(Schema.is(JsonScalar)(Number.POSITIVE_INFINITY)).toBe(false);
  expect(Schema.is(JsonScalar)(Number.NEGATIVE_INFINITY)).toBe(false);
});

describe("legacy authorization names cannot be imported", () => {
  test("public barrels do not export Policy or the old wire helpers", async () => {
    const root = await import("../../../src/index.ts");
    const db = await import("../../../src/db/index.ts");
    expect("policy" in root).toBe(false);
    expect("Policy" in root).toBe(false);
    expect("PolicyError" in db).toBe(false);
    expect("filterDb" in root).toBe(false);
    expect("parsePolicy" in root).toBe(false);
  });

  test("the IR barrel does not re-export runtime capability tags", async () => {
    const ir = await import("../../../src/internal/authorization/index.ts");
    expect("RawStorageAccess" in ir).toBe(false);
    expect("RuleSnapshotAccess" in ir).toBe(false);
    expect("AuthorizedApplicationAccess" in ir).toBe(false);
    expect("CatalogLocalOperations" in ir).toBe(false);
    expect("AuthenticationAdmission" in ir).toBe(false);
    expect("denyAllCapabilityLayer" in ir).toBe(false);
    expect("RawSnapshot" in ir).toBe(false);
    expect("RuleSnapshot" in ir).toBe(false);
    expect("ApplicationSnapshot" in ir).toBe(false);
    expect("AuthorizedSnapshot" in ir).toBe(false);
  });

  test("InstalledCatalogUnit is on the internal barrel and not on public barrels", async () => {
    const ir = await import("../../../src/internal/authorization/index.ts");
    const root = await import("../../../src/index.ts");
    const db = await import("../../../src/db/index.ts");
    expect("InstalledCatalogUnit" in ir).toBe(true);
    expect("sealInstalledCatalogUnit" in ir).toBe(true);
    expect("CatalogUnitCorrupt" in ir).toBe(true);
    expect("compareAndSwapCatalogUnit" in ir).toBe(false);
    expect("loadCatalogUnitAtBasis" in ir).toBe(false);
    expect("CatalogCasConflict" in ir).toBe(false);
    expect("InstalledCatalogUnit" in root).toBe(false);
    expect("sealInstalledCatalogUnit" in root).toBe(false);
    expect("requireUnitCoherence" in root).toBe(false);
    expect("CatalogUnitCorrupt" in root).toBe(false);
    expect("InstalledCatalogUnit" in db).toBe(false);
    expect("sealInstalledCatalogUnit" in db).toBe(false);
  });
});
