/**
 * Runtime authorization IR. No authoring syntax, no user callbacks.
 * Contract: `src/internal/design/authorization.md`.
 */

export {
  AUTHORIZATION_IR_VERSION,
  MAX_TRAVERSAL_DEPTH,
  REGISTERED_CLAIM_KEYS,
  type AuthorizationIR,
  type CatalogBinding,
  type FieldId,
  type InstalledAuthorizationIR,
  type IrDecision,
  type IrExpr,
  type IrOperand,
  type IrPath,
  type IrRule,
  type OperationId,
  type OperationTarget,
  type OwnerId,
  type OwnerKind,
  type PathStep,
  type PolicyTemplateIR,
  type PrincipalSpec,
} from "./ir.ts";
export { canonicalize, canonicalJson, hashPolicy, ruleIdOf, sha256Hex } from "./canonical.ts";
export { decodePolicyTemplate, parseAuthorizationIR, serializeAuthorizationIR } from "./parse.ts";
export { evaluatePure, traitOwnerOfField, type Truth } from "./eval.ts";
export {
  authorize,
  authorizeField,
  authorizeOperation,
  authorizeRow,
  authorizeTraitField,
  decide,
  projectionFromEvalCtx,
  type EvalCtx,
  type RuleRecord,
} from "./authorize.ts";
export {
  AuthorizationDenied,
  AuthorizationBudgetExceeded,
  CatalogMismatch,
  IncompleteRuleSnapshot,
  InvalidIR,
  LeaseExpired,
} from "./errors.ts";
export {
  MemoryRuleSnapshot,
  RuleSnapshot,
  planOfDecision,
  planOfRules,
  type CompleteRuleProjection,
  type LoadedValue,
  type RuleAccessPlan,
} from "./snapshot.ts";
export {
  AuthorizationBudget,
  AuthorizationLease,
  CatalogResolver,
  CountedBudget,
  StaticCatalogResolver,
  TimedLease,
  UnboundedLease,
  UnlimitedBudget,
} from "./services.ts";
export { catalogFromTemplate, installAgainstCatalog, installAuthorization } from "./install.ts";
