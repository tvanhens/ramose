/** Supported read-authorization authoring surface. */

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
} from "./internal/authorization/authoring/expr.ts";
export {
  $,
  path,
} from "./internal/authorization/authoring/path.ts";
export {
  read,
  type ReadBuilder,
} from "./internal/authorization/authoring/read.ts";
export {
  compileReadAuthorization,
} from "./internal/authorization/authoring/compile.ts";
export type {
  AuthExpr,
  AuthOperandInput,
  AuthPathLike as AuthPath,
  AuthPathProxy,
  CompileReadAuthorizationInput,
  FieldTargetFields,
  ReadRule,
  ReadTarget,
} from "./internal/authorization/authoring/types.ts";
