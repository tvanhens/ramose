/**
 * Read-authorization authoring language (#406).
 *
 * Compiles to catalog-relative {@link import("../ir.ts").PolicyTemplateIR}.
 * Not a public `ramose` / `ramose/db` export.
 */

export {
  allow,
  all,
  any,
  claim,
  contains,
  deny,
  eq,
  hasClass,
  lit,
  me,
  not,
  subject,
} from "./expr.ts";
export { $, path, seededPath } from "./path.ts";
export { read, type ReadBuilder } from "./read.ts";
export { compileReadAuthorization, compileReadAuthorizationResult } from "./compile.ts";
export {
  lowerOperationSchema,
  lowerOwnedOperations,
  type DeployedOperationDefinition,
  type LoweredOwnedOperations,
} from "./operations.ts";
export type {
  AuthExpr,
  AuthOperandInput,
  AuthPathLike as AuthPath,
  AuthPathProxy,
  CompileReadAuthorizationInput,
  FieldTargetFields,
  ReadRule,
  ReadTarget,
} from "./types.ts";
