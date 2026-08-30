/**
 * @internal Everything `db/` declares, flat.
 *
 * Not a package `exports` entry: the public surface is `./index.ts`
 * (`ramose/db`). This module exists so sibling modules and the tests
 * can reach the inferred / internal names — `AnySchema`, `EntityMap`,
 * `lowerQueryObject`, `Expect`/`Equal` — without each of them
 * naming a dozen files.
 */

export * from "./Field.ts";
export * from "./Binding.ts";
export * from "./creation.ts";
export * from "./reachability.ts";
export * from "./Schema.ts";
export * from "./composition.ts";
export * from "./Composer.ts";
export * from "./ensure.ts";
export * from "./equal.ts";
export * from "./Errors.ts";
export * from "./idents.ts";
export * from "./Entity.ts";
export * from "./Trait.ts";
export * from "./Graph.ts";
export {
  composerIdent,
  conflictingFieldName,
  entityTraitNameClash,
  traitCycle,
} from "./compose.ts";
export * from "./shapes.ts";
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
// The canonical plain-data query representation (#486). Portable, transport
// free, and compiled onto the same engine the fluent builder targets.
export * as QueryDocument from "./query/document/index.ts";
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
export * from "./Tx.ts";
export * from "./Operation.ts";
export * from "./valueTypes.ts";
// Field-returning `Ref` (eager entity / thunk / self) wins over the
// schema helper of the same name. `Field(Ref(User))` still works because
// `Field` accepts a Field.
export { Ref } from "./Field.ts";
