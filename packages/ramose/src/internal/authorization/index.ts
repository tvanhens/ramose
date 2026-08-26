/**
 * Runtime authorization IR. No authoring syntax, no user callbacks.
 * Contract: `src/internal/design/authorization.md`.
 */

export {
  AUTHORIZATION_IR_VERSION,
  MAX_TRAVERSAL_DEPTH,
  REGISTERED_CLAIM_KEYS,
  type AuthorizationIR,
  type FieldId,
  type IrDecision,
  type IrExpr,
  type IrOperand,
  type IrPath,
  type IrRule,
  type OperationId,
  type OwnerId,
  type OwnerKind,
  type PathStep,
} from "./ir.ts";
export { canonicalize, canonicalJson, fnv1a, ruleIdOf } from "./canonical.ts";
export { parseAuthorizationIR, serializeAuthorizationIR } from "./parse.ts";
export {
  authorizeField,
  authorizeOperation,
  authorizeRow,
  authorizeTraitField,
  decide,
  type EvalCtx,
  type RuleRecord,
} from "./eval.ts";
