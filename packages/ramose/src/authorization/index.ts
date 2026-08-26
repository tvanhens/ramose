/**
 * Deploy-time policy authoring.
 *
 * Compiles a typed policy into catalog-relative PolicyTemplateIR and binds
 * it to InstalledAuthorizationIR. Not exported from the browser runtime.
 */

export { Policy, compileAuthoring } from "./compile.ts";
export type { CompileFailure } from "./compile.ts";
export {
  bindAuthorization,
  bindAuthorizationResolved,
  revalidateInstalled,
} from "./bind.ts";
export type { BindFailure } from "./bind.ts";
export { authorPolicy } from "./authoring.ts";
export type {
  AuthRule,
  EntityRuleContext,
  PolicyBinding,
  PolicyHelpers,
  PolicyOptions,
  ResourceSnapshot,
  RuleContext,
  TargetedOpContext,
  TargetlessOpContext,
} from "./authoring.ts";
export {
  always,
  and,
  exists,
  hasClass,
  me,
  not,
  or,
  self,
  subject,
} from "./expr.ts";
export type { AuthExpr, ClaimCell, InputCell, PathCell } from "./expr.ts";
export { operation, operations } from "./operation.ts";
export type { AnyPolicyOperation, PolicyOperation } from "./operation.ts";
export { catalogDescriptorFrom } from "./catalog.ts";
