/** Effect Schema decoders for template and installed IR. Strict JSON only. */

import * as Schema from "effect/Schema";
import {
  INSTALLED_AUTHORIZATION_VERSION,
  MAX_CLASSES,
  MAX_CLAIMS,
  MAX_COLLECTION_SIZE,
  MAX_DECISIONS,
  MAX_IDENT_LENGTH,
  MAX_PATH_STEPS,
  MAX_RULES,
  MAX_STRING_LITERAL,
  POLICY_TEMPLATE_VERSION,
} from "./bounds.ts";
import { assertJsonOnly, JsonOnlyError } from "./json.ts";
import { InvalidInstalledIR, InvalidTemplate } from "./errors.ts";
import type { PolicyTemplateIR } from "./template.ts";
import type { InstalledAuthorizationIR } from "./installed.ts";

const boundedString = (max = MAX_IDENT_LENGTH) =>
  Schema.String.check(Schema.isMaxLength(max));

const Ident = boundedString(MAX_IDENT_LENGTH);
const ClassName = boundedString(MAX_IDENT_LENGTH);
const ClaimKey = boundedString(MAX_IDENT_LENGTH);
const RuleId = Schema.String.check(Schema.isMaxLength(64));

const OwnerKind = Schema.Literals(["entity", "trait"]);
const OperationTarget = Schema.Literals(["required", "none"]);

const OwnerRef = Schema.Struct({
  kind: OwnerKind,
  name: Ident,
});

const FieldRef = Schema.Struct({
  owner: OwnerRef,
  localName: Ident,
});

const CanonicalFieldRef = Schema.Struct({
  catalog: Ident,
  owner: OwnerRef,
  localName: Ident,
});

const PathRoot = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("resource") }),
  Schema.Struct({ _tag: Schema.Literal("binding"), name: Ident }),
]);

const PathStep = Schema.Struct({
  field: FieldRef,
});

const AuthPath = Schema.Struct({
  root: PathRoot,
  steps: Schema.Array(PathStep).check(Schema.isMaxLength(MAX_PATH_STEPS)),
});

const JsonLiteral = Schema.Union([
  Schema.String.check(Schema.isMaxLength(MAX_STRING_LITERAL)),
  Schema.Number.check(Schema.isFinite()),
  Schema.Boolean,
  Schema.Null,
]);

const Operand = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("path"), path: AuthPath }),
  Schema.Struct({ _tag: Schema.Literal("subject") }),
  Schema.Struct({ _tag: Schema.Literal("me") }),
  Schema.Struct({ _tag: Schema.Literal("claim"), key: ClaimKey }),
  Schema.Struct({ _tag: Schema.Literal("input"), key: ClaimKey }),
  Schema.Struct({ _tag: Schema.Literal("lit"), value: JsonLiteral }),
  Schema.Struct({ _tag: Schema.Literal("binding"), name: Ident }),
]);

const Expr: Schema.suspend<Schema.Top> = Schema.suspend(() =>
  Schema.Union([
    Schema.Struct({ _tag: Schema.Literal("const"), value: Schema.Boolean }),
    Schema.Struct({
      _tag: Schema.Literal("and"),
      exprs: Schema.Array(Expr).check(Schema.isMaxLength(MAX_COLLECTION_SIZE)),
    }),
    Schema.Struct({
      _tag: Schema.Literal("or"),
      exprs: Schema.Array(Expr).check(Schema.isMaxLength(MAX_COLLECTION_SIZE)),
    }),
    Schema.Struct({ _tag: Schema.Literal("not"), expr: Expr }),
    Schema.Struct({
      _tag: Schema.Literal("eq"),
      left: Operand,
      right: Operand,
    }),
    Schema.Struct({ _tag: Schema.Literal("has"), operand: Operand }),
    Schema.Struct({
      _tag: Schema.Literal("some"),
      path: AuthPath,
      bind: Ident,
      pred: Expr,
    }),
    Schema.Struct({
      _tag: Schema.Literal("overlaps"),
      left: AuthPath,
      right: AuthPath,
    }),
    Schema.Struct({
      _tag: Schema.Literal("exists"),
      entity: Schema.Struct({ name: Ident }),
      bind: Ident,
      pred: Expr,
    }),
    Schema.Struct({ _tag: Schema.Literal("hasClass"), class: ClassName }),
  ]),
);

const RuleFocus = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("entity"), name: Ident }),
  Schema.Struct({ _tag: Schema.Literal("trait"), name: Ident }),
  Schema.Struct({
    _tag: Schema.Literal("operation"),
    owner: OwnerRef,
    localName: Ident,
    target: OperationTarget,
  }),
]);

const Decision = Schema.Struct({
  allow: Schema.Array(RuleId).check(Schema.isMaxLength(MAX_COLLECTION_SIZE)),
  deny: Schema.Array(RuleId).check(Schema.isMaxLength(MAX_COLLECTION_SIZE)),
});

const Decisions = Schema.Struct({
  rows: Schema.Record(Schema.String, Decision),
  traits: Schema.Record(Schema.String, Decision),
  fields: Schema.Record(Schema.String, Decision),
  operations: Schema.Record(Schema.String, Decision),
});

const RuleMetadata = {
  usesResource: Schema.Boolean,
  usesInput: Schema.Boolean,
  usesMe: Schema.Boolean,
  usesSubject: Schema.Boolean,
  traversalDepth: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
  existsNesting: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
  exprNodes: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
  dependencies: Schema.Array(Ident).check(
    Schema.isMaxLength(MAX_COLLECTION_SIZE),
  ),
};

const TemplateRule = Schema.Struct({
  id: RuleId,
  focus: RuleFocus,
  expr: Expr,
  ...RuleMetadata,
});

export const PolicyTemplateIRSchema = Schema.Struct({
  _tag: Schema.Literal("PolicyTemplateIR"),
  version: Schema.Literal(POLICY_TEMPLATE_VERSION),
  principal: Schema.Struct({
    subjectClaim: Ident,
    entity: Schema.optional(FieldRef),
  }),
  classes: Schema.Array(ClassName).check(Schema.isMaxLength(MAX_CLASSES)),
  claims: Schema.Array(ClaimKey).check(Schema.isMaxLength(MAX_CLAIMS)),
  rules: Schema.Array(TemplateRule).check(Schema.isMaxLength(MAX_RULES)),
  decisions: Decisions,
});

const CanonicalEntityRef = Schema.Struct({
  catalog: Ident,
  name: Ident,
});

const CanonicalTraitRef = Schema.Struct({
  catalog: Ident,
  name: Ident,
});

const CanonicalOperationRef = Schema.Struct({
  catalog: Ident,
  owner: OwnerRef,
  localName: Ident,
  target: OperationTarget,
});

const FactNeed = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("resourceField"),
    field: FieldRef,
  }),
  Schema.Struct({ _tag: Schema.Literal("principalRow") }),
  Schema.Struct({ _tag: Schema.Literal("claim"), key: ClaimKey }),
  Schema.Struct({ _tag: Schema.Literal("input"), key: ClaimKey }),
  Schema.Struct({ _tag: Schema.Literal("subject") }),
]);

const IndexNeed = Schema.Struct({
  _tag: Schema.Literal("entityScan"),
  entity: Schema.Struct({ name: Ident }),
  fields: Schema.Array(FieldRef).check(Schema.isMaxLength(MAX_COLLECTION_SIZE)),
});

const ExistsNeed = Schema.Struct({
  entity: Schema.Struct({ name: Ident }),
  bind: Ident,
});

const RuleAccessPlan = Schema.Struct({
  ruleId: RuleId,
  facts: Schema.Array(FactNeed).check(Schema.isMaxLength(MAX_COLLECTION_SIZE)),
  indexes: Schema.Array(IndexNeed).check(Schema.isMaxLength(MAX_COLLECTION_SIZE)),
  exists: Schema.Array(ExistsNeed).check(Schema.isMaxLength(MAX_COLLECTION_SIZE)),
  maxTraversalDepth: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
  usesMe: Schema.Boolean,
  usesResource: Schema.Boolean,
  usesInput: Schema.Boolean,
});

const DecisionAccessPlan = Schema.Struct({
  kind: Schema.Literals(["row", "trait", "field", "operation"]),
  key: boundedString(256),
  rules: Schema.Array(RuleAccessPlan).check(
    Schema.isMaxLength(MAX_COLLECTION_SIZE),
  ),
});

const InstalledRule = Schema.Struct({
  id: RuleId,
  focus: RuleFocus,
  expr: Expr,
  ...RuleMetadata,
  accessPlan: RuleAccessPlan,
});

export const InstalledAuthorizationIRSchema = Schema.Struct({
  _tag: Schema.Literal("InstalledAuthorizationIR"),
  version: Schema.Literal(INSTALLED_AUTHORIZATION_VERSION),
  catalogId: Ident,
  catalogVersion: Ident,
  catalogFingerprint: boundedString(64),
  policyHash: boundedString(64),
  principal: Schema.Struct({
    subjectClaim: Ident,
    entity: Schema.optional(CanonicalFieldRef),
  }),
  classes: Schema.Array(ClassName).check(Schema.isMaxLength(MAX_CLASSES)),
  claims: Schema.Array(ClaimKey).check(Schema.isMaxLength(MAX_CLAIMS)),
  identities: Schema.Struct({
    entities: Schema.Array(CanonicalEntityRef).check(
      Schema.isMaxLength(MAX_COLLECTION_SIZE),
    ),
    traits: Schema.Array(CanonicalTraitRef).check(
      Schema.isMaxLength(MAX_COLLECTION_SIZE),
    ),
    fields: Schema.Array(CanonicalFieldRef).check(
      Schema.isMaxLength(MAX_DECISIONS),
    ),
    operations: Schema.Array(CanonicalOperationRef).check(
      Schema.isMaxLength(MAX_COLLECTION_SIZE),
    ),
  }),
  traitComposition: Schema.Record(
    Schema.String,
    Schema.Array(Ident).check(Schema.isMaxLength(MAX_COLLECTION_SIZE)),
  ),
  operationDescriptors: Schema.Array(
    Schema.Struct({
      identity: CanonicalOperationRef,
      inputKeys: Schema.Array(ClaimKey).check(
        Schema.isMaxLength(MAX_COLLECTION_SIZE),
      ),
    }),
  ).check(Schema.isMaxLength(MAX_COLLECTION_SIZE)),
  rules: Schema.Array(InstalledRule).check(Schema.isMaxLength(MAX_RULES)),
  decisions: Decisions,
  accessPlans: Schema.Array(DecisionAccessPlan).check(
    Schema.isMaxLength(MAX_DECISIONS),
  ),
});

const decisionCount = (decisions: {
  readonly rows: Readonly<Record<string, unknown>>;
  readonly traits: Readonly<Record<string, unknown>>;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly operations: Readonly<Record<string, unknown>>;
}): number =>
  Object.keys(decisions.rows).length +
  Object.keys(decisions.traits).length +
  Object.keys(decisions.fields).length +
  Object.keys(decisions.operations).length;

const runDecode = <E>(
  schema: unknown,
  value: unknown,
  toError: (message: string, path?: string) => E,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: E } => {
  try {
    assertJsonOnly(value);
  } catch (cause) {
    if (cause instanceof JsonOnlyError) {
      return { ok: false, error: toError(cause.message, cause.path) };
    }
    return { ok: false, error: toError(String(cause)) };
  }
  const result = (
    Schema.decodeUnknownResult as (
      schema: unknown,
      options?: { readonly onExcessProperty?: "ignore" | "error" | "preserve" },
    ) => (input: unknown) =>
      | { readonly _tag: "Success"; readonly success: unknown }
      | { readonly _tag: "Failure"; readonly failure: { readonly message?: string } }
  )(schema, { onExcessProperty: "error" })(value);
  if (result._tag === "Failure") {
    const issue = result.failure;
    return {
      ok: false,
      error: toError(issue.message ?? "structurally invalid IR"),
    };
  }
  const decoded = result.success as {
    readonly decisions: {
      readonly rows: Readonly<Record<string, unknown>>;
      readonly traits: Readonly<Record<string, unknown>>;
      readonly fields: Readonly<Record<string, unknown>>;
      readonly operations: Readonly<Record<string, unknown>>;
    };
  };
  if (decisionCount(decoded.decisions) > MAX_DECISIONS) {
    return {
      ok: false,
      error: toError("too many decisions"),
    };
  }
  return { ok: true, value: result.success };
};

export const decodeTemplateDocument = (
  value: unknown,
): PolicyTemplateIR => {
  const result = runDecode(
    PolicyTemplateIRSchema,
    value,
    (message, path) => new InvalidTemplate({ message, path }),
  );
  if (!result.ok) throw result.error;
  return result.value as PolicyTemplateIR;
};

export const decodeInstalledDocument = (
  value: unknown,
): InstalledAuthorizationIR => {
  const result = runDecode(
    InstalledAuthorizationIRSchema,
    value,
    (message, path) => new InvalidInstalledIR({ message, path }),
  );
  if (!result.ok) throw result.error;
  return result.value as InstalledAuthorizationIR;
};

export const tryDecodeTemplateDocument = (
  value: unknown,
):
  | { readonly _tag: "Right"; readonly right: PolicyTemplateIR }
  | { readonly _tag: "Left"; readonly left: InvalidTemplate } => {
  const result = runDecode(
    PolicyTemplateIRSchema,
    value,
    (message, path) => new InvalidTemplate({ message, path }),
  );
  return result.ok
    ? { _tag: "Right", right: result.value as PolicyTemplateIR }
    : { _tag: "Left", left: result.error };
};

export const tryDecodeInstalledDocument = (
  value: unknown,
):
  | { readonly _tag: "Right"; readonly right: InstalledAuthorizationIR }
  | { readonly _tag: "Left"; readonly left: InvalidInstalledIR } => {
  const result = runDecode(
    InstalledAuthorizationIRSchema,
    value,
    (message, path) => new InvalidInstalledIR({ message, path }),
  );
  return result.ok
    ? { _tag: "Right", right: result.value as InstalledAuthorizationIR }
    : { _tag: "Left", left: result.error };
};
