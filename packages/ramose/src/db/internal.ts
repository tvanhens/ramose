/**
 * @internal Everything `db/` declares, flat.
 *
 * Not a package `exports` entry: the public surface is `./index.ts`
 * (`ramose/db`). This module exists so sibling modules and the tests
 * can reach the inferred / internal names — `AnySchema`, `EntityMap`,
 * `lowerQueryObject`, `makeDatabases`, `Expect`/`Equal` — without each of them
 * naming a dozen files.
 */

export * from "./Field.ts";
export * from "./Schema.ts";
export * from "./connect.ts";
export * from "./factory.ts";
export * from "./Db.ts";
export {
  Databases,
  layer,
  type EffectClientOptions,
  type EffectDb,
  type EffectReadDb,
  type EffectToken,
} from "./effect.ts";
export type { Subscription } from "./subscription.ts";
export * from "./ensure.ts";
export * from "./evolution.ts";
export * from "./equal.ts";
export * from "./Errors.ts";
export * from "./SchemaErrors.ts";
export * from "./http.ts";
export * from "./idents.ts";
export * from "./Entity.ts";
export * from "./Trait.ts";
export {
  composerIdent,
  conflictingFieldName,
  entityTraitNameClash,
  traitCycle,
} from "./compose.ts";
export * from "./shapes.ts";
export {
  assertLoweringPurity,
  canonicalAstKey,
  computeAstKey,
  computePullPatternKey,
  liveSubscriptionKey,
  pullPatternKey,
  queryAstKey,
  queryStructureKey,
} from "./astKey.ts";
export { shareEqualDeep } from "./shareEqualDeep.ts";
export * from "./Eid.ts";
export { tempid, type Tempid } from "./entityArg.ts";
export {
  type Again,
  type AllRow,
  type AllShape,
  type RecurDepth,
  type RecurStub,
  type Unroll,
  type AttrPull,
  type IdentPullAttr,
  type IdentPullIdents,
  type IdentPullPattern,
  type IdentPullResult,
  type Pull,
  type PullDefault,
  type PullNested,
  type PullOptional,
  type StructPullResult,
  type ValidatePull,
  again,
  all,
  isAgain,
  isAllShape,
  isPullDefault,
  isPullNested,
  isPullOptional,
  lowerPullPattern,
  pick,
  pullDefault,
  reshapePullResult,
} from "./Pull.ts";
export * as Query from "./query/surface.ts";
export {
  Q,
  isPipeline,
  isQueryObject,
  isRuleValue,
  lowerQueryAst,
  lowerQueryObject,
  type AnyQueryObject,
  type EntityRow,
  type FluentQuery,
  type RefIdCell,
  type LoweredKernelQuery,
  type QueryObject,
  type Row,
  type Rows,
  type RuleValue,
} from "./query/index.ts";
export * from "./session.ts";
export * from "./token.ts";
export * from "./Tx.ts";
export { seedWrite, submitRaw } from "./seed.ts";
export * from "./Operation.ts";
export * from "./valueTypes.ts";
// Field-returning `Ref` (eager entity / thunk / self) wins over the
// schema helper of the same name. `Field(Ref(User))` still works because
// `Field` accepts a Field.
export { Ref } from "./Field.ts";
