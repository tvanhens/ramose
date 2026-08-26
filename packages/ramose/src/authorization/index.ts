/**
 * Policy authoring API. Compiles to the data-only authorization IR.
 *
 * Runtime enforcement consumes `src/internal/authorization` — not this
 * module, and not user callbacks. Contract:
 * `src/internal/design/authorization.md` (**LANG-1**–**LANG-6**).
 */

export {
  AUTH_LOCAL_NAME,
  AUTH_OWNER,
  AUTH_TARGET,
  read,
  rule,
  run,
  withOperations,
  type Allowable,
  type AuthBinding,
  type AuthOperation,
  type AuthRule,
  type RuleContext,
} from "./authoring.ts";
export {
  and,
  eq,
  exists,
  has,
  hasClass,
  not,
  or,
  overlaps,
  some,
  type AuthExpr,
  type AuthPath,
  type Snapshot,
} from "./expr.ts";
export { compileAuthorization, compileTemplate, type AuthorizationHead } from "./compile.ts";
export {
  AUTHORIZATION_IR_VERSION,
  MAX_TRAVERSAL_DEPTH,
  type AuthorizationIR,
  type InstalledAuthorizationIR,
  type PolicyTemplateIR,
} from "../internal/authorization/ir.ts";
export { parseAuthorizationIR, serializeAuthorizationIR } from "../internal/authorization/parse.ts";
