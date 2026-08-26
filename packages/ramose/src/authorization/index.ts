/**
 * Policy authoring API. Compiles to the data-only authorization IR.
 *
 * Runtime enforcement consumes `src/internal/authorization` — not this
 * module, and not user callbacks. Contract:
 * `src/internal/design/authorization.md` (**LANG-1**–**LANG-6**).
 */

export {
  read,
  run,
  rule,
  withOperations,
  AUTH_OWNER,
  type Allowable,
  type AuthBinding,
  type AuthOperation,
  type AuthRule,
  type RuleContext,
} from "./authoring.ts";
export {
  and,
  or,
  not,
  eq,
  has,
  some,
  overlaps,
  exists,
  hasClass,
  type AuthExpr,
  type AuthPath,
  type Snapshot,
} from "./expr.ts";
export { compileAuthorization, type AuthorizationHead } from "./compile.ts";
export {
  AUTHORIZATION_IR_VERSION,
  MAX_TRAVERSAL_DEPTH,
  type AuthorizationIR,
} from "../internal/authorization/ir.ts";
export { parseAuthorizationIR, serializeAuthorizationIR } from "../internal/authorization/parse.ts";
