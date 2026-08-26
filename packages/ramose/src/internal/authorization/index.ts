/**
 * Runtime authorization kernel.
 *
 * Installed IR types, sealed artifacts, access plans, and the pure
 * evaluator. Authoring, compilation, and template binding are not
 * exported here and must not be imported by runtime enforcement.
 */

export {
  INSTALLED_AUTHORIZATION_VERSION,
  POLICY_TEMPLATE_VERSION,
} from "./bounds.ts";
export type {
  InstalledAuthorizationVersion,
  PolicyTemplateVersion,
} from "./bounds.ts";

export {
  canonicalEntityKey,
  canonicalFieldKey,
  canonicalOperationKey,
  canonicalTraitKey,
  relativeFieldKey,
  relativeOperationKey,
} from "./identity.ts";
export type {
  CanonicalEntityRef,
  CanonicalFieldRef,
  CanonicalOperationRef,
  CanonicalTraitRef,
  CatalogId,
  CatalogVersion,
  OperationTarget,
  OwnerKind,
  RelativeEntityRef,
  RelativeFieldRef,
  RelativeOperationRef,
  RelativeOwnerRef,
  RelativeTraitRef,
  RuleId,
} from "./identity.ts";

export type { JsonLiteral, JsonValue } from "./json.ts";

export {
  Absent,
  authorizes,
  False,
  Incomplete,
  Invalid,
  Present,
  PresentMany,
  True,
  Unavailable,
} from "./truth.ts";
export type { IncompleteReason, Projection, Truth } from "./truth.ts";

export type { Expr, Operand, PathRoot, PathStep, RuleFocus } from "./expr.ts";

export { isPolicyTemplateIR } from "./template.ts";
export type {
  PolicyTemplateIR,
  TemplateDecision,
  TemplatePrincipal,
  TemplateRule,
} from "./template.ts";

export {
  InstalledBrand,
  isInstalledAuthorizationIR,
  isSealedInstalled,
} from "./installed.ts";
export type {
  InstalledAuthorizationIR,
  InstalledDecision,
  InstalledPrincipal,
  InstalledRule,
  SealedInstalledAuthorizationIR,
} from "./installed.ts";

export type {
  DecisionAccessPlan,
  ExistsNeed,
  FactNeed,
  IndexNeed,
  RuleAccessPlan,
} from "./plan.ts";

export type {
  CatalogDescriptor,
  CatalogEntityDescriptor,
  CatalogFieldDescriptor,
  CatalogOperationDescriptor,
  CatalogTraitDescriptor,
} from "./descriptor.ts";

export {
  AuthorizationDenied,
  AuthorizationBudgetExceeded,
  CatalogMismatch,
  HashFailure,
  IncompleteRuleSnapshot,
  InvalidInstalledIR,
  InvalidTemplate,
  LeaseExpired,
  RuleIdentityCollision,
} from "./errors.ts";
export type { AuthorizationFailure } from "./errors.ts";

export {
  authorizeField,
  authorizeOperation,
  authorizeRow,
  authorizeTrait,
  createBudget,
  decide,
  evaluateDecision,
  evaluateExpr,
  evaluateRule,
} from "./eval.ts";
export type {
  BudgetState,
  EntityStore,
  EvalContext,
  EvalPrincipal,
  RuleRecord,
  RuleSnapshotData,
} from "./eval.ts";

export { sealInstalled } from "./seal.ts";
export { canonicalJson } from "./canonical.ts";
export { sha256Hex } from "./hash.ts";

export {
  decodeInstalledDocument,
  decodeTemplateDocument,
  tryDecodeInstalledDocument,
  tryDecodeTemplateDocument,
} from "./schema.ts";

export {
  AuthorizationBudgetLive,
  AuthorizationBudgetService,
  AuthorizationClock,
  AuthorizationClockLive,
  AuthorizationHash,
  AuthorizationHashLive,
  AuthorizationTelemetry,
  AuthorizationTelemetrySilent,
  CatalogResolver,
  RuleSnapshot,
  inMemoryCatalogResolver,
} from "./services.ts";
export type { AuthorizationBudget, AuthorizationLease, InternalAuthEvent } from "./services.ts";

export { closeTruth, failClosed } from "./fail-closed.ts";

export {
  bindTemplate,
  semanticallyValidateInstalled,
  semanticallyValidateTemplate,
} from "./validate.ts";
