/**
 * Pure access-plan derivation.
 *
 * Walks a validated expression once and records every fact, membership,
 * existential scan, and required index the rule needs. Missing a required
 * lookup is an error. Extra safe facts may be dropped during normalization
 * without changing meaning. No Effect is allocated per node.
 */

import * as Result from "effect/Result";
import type { FieldDescriptor, RuleAccessLookup, RuleAccessPlan } from "../catalog.ts";
import type { CanonicalAuthorizationExpr, CanonicalRefTerm, CanonicalValueTerm } from "../expr.ts";
import type { EntityId, FieldId } from "../identities.ts";
import type { CanonicalAuthorizationRule } from "../ir.ts";
import type { InstalledPrincipalResolution } from "../principal.ts";
import {
  requireEntity,
  requireField,
  type PreparedAuthorizationCatalog,
  type RowFocus,
} from "../validation/catalog.ts";
import { entityKey, fieldKey, invalid, type ValidateFailure } from "../validation/common.ts";
import { rowFromRefTarget } from "../validation/types.ts";
import { meEntity, resourceFocus } from "../validation/traversal.ts";

export type AssembleFailure = ValidateFailure;

type ExistsScope = {
  readonly bind: string;
  readonly entity: EntityId;
  readonly fields: Map<string, FieldId>;
};

type PlanCollector = {
  readonly fields: Map<string, FieldId>;
  readonly entities: Map<string, EntityId>;
  readonly indexes: Map<string, FieldId>;
  readonly exists: Map<string, ExistsScope>;
};

const collector = (): PlanCollector => ({
  fields: new Map(),
  entities: new Map(),
  indexes: new Map(),
  exists: new Map(),
});

const addEntity = (into: PlanCollector, entity: EntityId): void => {
  into.entities.set(entityKey(entity), entity);
};

const addFieldFact = (
  into: PlanCollector,
  field: FieldId,
  descriptor: FieldDescriptor,
): void => {
  into.fields.set(fieldKey(field), field);
  if (descriptor.index) into.indexes.set(fieldKey(field), field);
};

const addExistsField = (scope: ExistsScope | undefined, field: FieldId): void => {
  if (scope === undefined) return;
  scope.fields.set(fieldKey(field), field);
};

const composersOf = (
  index: PreparedAuthorizationCatalog,
  traitName: string,
): EntityId[] => {
  const composers: EntityId[] = [];
  for (const [name, traits] of index.entityTraits) {
    if (traits.has(traitName)) {
      const entity = index.entities.get(name);
      if (entity !== undefined) composers.push(entity);
    }
  }
  return composers;
};

const addMembership = (
  index: PreparedAuthorizationCatalog,
  into: PlanCollector,
  focus: RowFocus,
): void => {
  if (focus._tag === "entity") {
    addEntity(into, focus.entity);
    return;
  }
  for (const composer of composersOf(index, focus.trait.name)) {
    addEntity(into, composer);
  }
};

const addPrincipalResolution = (
  index: PreparedAuthorizationCatalog,
  into: PlanCollector,
  principal: InstalledPrincipalResolution,
): Result.Result<void, AssembleFailure> => {
  if (principal.entity === undefined) return Result.succeed(undefined);
  const field = requireField(index, principal.entity, "principal field");
  if (Result.isFailure(field)) return Result.fail(field.failure);
  if (field.success.unique === undefined) {
    return invalid("principal field is not unique");
  }
  if (!field.success.index) {
    return invalid(
      `required index cannot be represented for principal field '${field.success.id.owner.name}.${field.success.id.localName}'`,
    );
  }
  if (field.success.id.owner.kind !== "entity") {
    return invalid("principal field must be entity-owned");
  }
  const entity = index.entities.get(field.success.id.owner.name);
  if (entity === undefined) return invalid("missing principal entity");
  addFieldFact(into, field.success.id, field.success);
  addEntity(into, entity);
  into.indexes.set(fieldKey(field.success.id), field.success.id);
  return Result.succeed(undefined);
};

const walkRef = (
  index: PreparedAuthorizationCatalog,
  term: CanonicalRefTerm,
  resource: RowFocus | undefined,
  me: EntityId | undefined,
  binds: ReadonlyMap<string, RowFocus>,
  scopes: ReadonlyArray<ExistsScope>,
  into: PlanCollector,
  principal: InstalledPrincipalResolution,
): Result.Result<void, AssembleFailure> => {
  let current: RowFocus | undefined;
  switch (term.root._tag) {
    case "resource":
      if (resource === undefined) {
        return invalid("resource is not available in this rule focus");
      }
      current = resource;
      addMembership(index, into, resource);
      break;
    case "me": {
      if (me === undefined) {
        return invalid("structurally invalid me traversal without a principal entity");
      }
      current = { _tag: "entity", entity: me };
      const principalOk = addPrincipalResolution(index, into, principal);
      if (Result.isFailure(principalOk)) return Result.fail(principalOk.failure);
      addEntity(into, me);
      break;
    }
    case "bind": {
      const bound = binds.get(term.root.name);
      if (bound === undefined) return invalid(`unbound name '${term.root.name}'`);
      current = bound;
      break;
    }
  }

  const bindName = term.root._tag === "bind" ? term.root.name : undefined;
  const existsScope =
    bindName === undefined
      ? undefined
      : [...scopes].reverse().find((scope) => scope.bind === bindName);

  for (let i = 0; i < term.steps.length; i++) {
    const step = term.steps[i]!;
    const field = requireField(index, step.field, "access-plan field");
    if (Result.isFailure(field)) return Result.fail(field.failure);
    addFieldFact(into, field.success.id, field.success);
    addExistsField(existsScope, field.success.id);
    if (field.success.valueType !== "ref") {
      if (i !== term.steps.length - 1) {
        return invalid(`non-ref traversal through '${step.field.localName}'`);
      }
      break;
    }
    const next = rowFromRefTarget(index, field.success.refTarget, field.success.id.owner);
    if (Result.isFailure(next)) return Result.fail(next.failure);
    current = next.success;
    if (current !== undefined) addMembership(index, into, current);
  }
  return Result.succeed(undefined);
};

const walkValue = (
  index: PreparedAuthorizationCatalog,
  term: CanonicalValueTerm,
  resource: RowFocus | undefined,
  me: EntityId | undefined,
  binds: ReadonlyMap<string, RowFocus>,
  scopes: ReadonlyArray<ExistsScope>,
  into: PlanCollector,
  principal: InstalledPrincipalResolution,
): Result.Result<void, AssembleFailure> => {
  switch (term._tag) {
    case "ref":
      return walkRef(index, term, resource, me, binds, scopes, into, principal);
    case "me": {
      const principalOk = addPrincipalResolution(index, into, principal);
      if (Result.isFailure(principalOk)) return Result.fail(principalOk.failure);
      if (me !== undefined) addEntity(into, me);
      return Result.succeed(undefined);
    }
    case "lit":
    case "subject":
    case "claim":
    case "input":
    case "bind":
      return Result.succeed(undefined);
  }
};

const walkExpr = (
  index: PreparedAuthorizationCatalog,
  expr: CanonicalAuthorizationExpr,
  resource: RowFocus | undefined,
  me: EntityId | undefined,
  binds: ReadonlyMap<string, RowFocus>,
  scopes: ReadonlyArray<ExistsScope>,
  into: PlanCollector,
  principal: InstalledPrincipalResolution,
): Result.Result<void, AssembleFailure> => {
  switch (expr._tag) {
    case "const":
    case "hasClass":
      return Result.succeed(undefined);
    case "and":
    case "or": {
      for (const child of expr.exprs) {
        const part = walkExpr(index, child, resource, me, binds, scopes, into, principal);
        if (Result.isFailure(part)) return Result.fail(part.failure);
      }
      return Result.succeed(undefined);
    }
    case "not":
      return walkExpr(index, expr.expr, resource, me, binds, scopes, into, principal);
    case "eq": {
      const left = walkValue(index, expr.left, resource, me, binds, scopes, into, principal);
      if (Result.isFailure(left)) return Result.fail(left.failure);
      return walkValue(index, expr.right, resource, me, binds, scopes, into, principal);
    }
    case "has":
      return walkValue(index, expr.term, resource, me, binds, scopes, into, principal);
    case "in": {
      const value = walkValue(index, expr.value, resource, me, binds, scopes, into, principal);
      if (Result.isFailure(value)) return Result.fail(value.failure);
      return walkValue(index, expr.collection, resource, me, binds, scopes, into, principal);
    }
    case "some": {
      const collection = walkRef(
        index,
        expr.collection,
        resource,
        me,
        binds,
        scopes,
        into,
        principal,
      );
      if (Result.isFailure(collection)) return Result.fail(collection.failure);
      const last = expr.collection.steps[expr.collection.steps.length - 1];
      if (last === undefined) return invalid("some requires a ref traversal");
      const field = requireField(index, last.field, "some collection field");
      if (Result.isFailure(field)) return Result.fail(field.failure);
      if (field.success.valueType !== "ref") return invalid("some requires a many-valued ref collection");
      const row = rowFromRefTarget(index, field.success.refTarget, field.success.id.owner);
      if (Result.isFailure(row)) return Result.fail(row.failure);
      if (row.success === undefined) return invalid("some cannot bind an untargeted ref");
      const nextBinds = new Map(binds);
      nextBinds.set(expr.bind, row.success);
      return walkExpr(index, expr.pred, resource, me, nextBinds, scopes, into, principal);
    }
    case "overlaps": {
      const left = walkRef(index, expr.left, resource, me, binds, scopes, into, principal);
      if (Result.isFailure(left)) return Result.fail(left.failure);
      return walkRef(index, expr.right, resource, me, binds, scopes, into, principal);
    }
    case "exists": {
      const entity = requireEntity(index, expr.entity, "exists entity");
      if (Result.isFailure(entity)) return Result.fail(entity.failure);
      addEntity(into, entity.success);
      const key = entityKey(entity.success);
      const existing = into.exists.get(key);
      const fields = existing?.fields ?? new Map();
      const scope: ExistsScope = { bind: expr.bind, entity: entity.success, fields };
      if (existing === undefined) into.exists.set(key, scope);
      const nextBinds = new Map(binds);
      nextBinds.set(expr.bind, { _tag: "entity", entity: entity.success });
      return walkExpr(index, expr.pred, resource, me, nextBinds, [...scopes, scope], into, principal);
    }
  }
};

const sortByKey = <T>(entries: Iterable<[string, T]>): T[] =>
  [...entries].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)).map(([, value]) => value);

const lookupsFrom = (into: PlanCollector): RuleAccessLookup[] => {
  const lookups: RuleAccessLookup[] = [];
  for (const entity of sortByKey(into.entities)) {
    lookups.push({ _tag: "entity", entity });
  }
  for (const scope of sortByKey(into.exists)) {
    lookups.push({
      _tag: "exists",
      entity: scope.entity,
      fields: sortByKey(scope.fields),
    });
  }
  for (const field of sortByKey(into.fields)) {
    lookups.push({ _tag: "field", field });
  }
  for (const field of sortByKey(into.indexes)) {
    lookups.push({ _tag: "index", field });
  }
  return lookups;
};

const lookupIdentity = (lookup: RuleAccessLookup): string => {
  switch (lookup._tag) {
    case "entity":
      return `entity${entityKey(lookup.entity)}`;
    case "exists":
      return `exists${entityKey(lookup.entity)}${lookup.fields.map((field) => fieldKey(field)).join("")}`;
    case "field":
      return `field${fieldKey(lookup.field)}`;
    case "index":
      return `index${fieldKey(lookup.field)}`;
  }
};

const existsCovers = (actual: RuleAccessLookup, required: RuleAccessLookup): boolean => {
  if (actual._tag !== "exists" || required._tag !== "exists") return false;
  if (entityKey(actual.entity) !== entityKey(required.entity)) return false;
  const have = new Set(actual.fields.map(fieldKey));
  return required.fields.every((field) => have.has(fieldKey(field)));
};

const lookupCovered = (
  actual: ReadonlyArray<RuleAccessLookup>,
  required: RuleAccessLookup,
  identities: ReadonlySet<string>,
): boolean => {
  if (required._tag === "exists") {
    return actual.some((lookup) => existsCovers(lookup, required));
  }
  return identities.has(lookupIdentity(required));
};

/** True when `actual` contains every required lookup. Extra actual lookups are allowed. */
export const accessPlanCovers = (
  actual: ReadonlyArray<RuleAccessLookup>,
  required: ReadonlyArray<RuleAccessLookup>,
): boolean => {
  const have = new Set(actual.filter((lookup) => lookup._tag !== "exists").map(lookupIdentity));
  for (const lookup of required) {
    if (!lookupCovered(actual, lookup, have)) return false;
  }
  return true;
};

export const missingAccessLookups = (
  actual: ReadonlyArray<RuleAccessLookup>,
  required: ReadonlyArray<RuleAccessLookup>,
): RuleAccessLookup[] => {
  const have = new Set(actual.filter((lookup) => lookup._tag !== "exists").map(lookupIdentity));
  return required.filter((lookup) => !lookupCovered(actual, lookup, have));
};

export const requireCompleteAccessPlan = (
  plan: RuleAccessPlan,
  required: ReadonlyArray<RuleAccessLookup>,
): Result.Result<void, AssembleFailure> => {
  const missing = missingAccessLookups(plan.lookups, required);
  if (missing.length > 0) {
    return invalid("required access lookup was omitted");
  }
  return Result.succeed(undefined);
};

/**
 * Derive the complete access plan for one validated rule. Synchronous and
 * pure: catalog lookups are map reads, not Effects.
 */
export const deriveRuleAccessPlan = (
  index: PreparedAuthorizationCatalog,
  rule: CanonicalAuthorizationRule,
  principal: InstalledPrincipalResolution,
): Result.Result<RuleAccessPlan, AssembleFailure> => {
  const resource = resourceFocus(index, rule.focus);
  if (Result.isFailure(resource)) return Result.fail(resource.failure);
  const me = meEntity(index, principal);
  if (Result.isFailure(me)) return Result.fail(me.failure);
  const into = collector();
  if (rule.usesResource && resource.success !== undefined) {
    addMembership(index, into, resource.success);
  }
  if (rule.usesMe) {
    const principalOk = addPrincipalResolution(index, into, principal);
    if (Result.isFailure(principalOk)) return Result.fail(principalOk.failure);
  }
  const walked = walkExpr(index, rule.expr, resource.success, me.success, new Map(), [], into, principal);
  if (Result.isFailure(walked)) return Result.fail(walked.failure);
  const lookups = lookupsFrom(into);
  const plan: RuleAccessPlan = { rule: rule.id, lookups };
  const complete = requireCompleteAccessPlan(plan, lookups);
  if (Result.isFailure(complete)) return Result.fail(complete.failure);
  return Result.succeed(plan);
};

export const deriveAccessPlans = (
  index: PreparedAuthorizationCatalog,
  rules: ReadonlyArray<CanonicalAuthorizationRule>,
  principal: InstalledPrincipalResolution,
): Result.Result<ReadonlyArray<RuleAccessPlan>, AssembleFailure> => {
  const plans: RuleAccessPlan[] = [];
  const seen = new Set<string>();
  for (const rule of rules) {
    const plan = deriveRuleAccessPlan(index, rule, principal);
    if (Result.isFailure(plan)) return Result.fail(plan.failure);
    if (seen.has(plan.success.rule)) {
      return invalid(`duplicate access-plan identity: ${plan.success.rule}`);
    }
    seen.add(plan.success.rule);
    plans.push(plan.success);
  }
  plans.sort((left, right) => (left.rule < right.rule ? -1 : left.rule > right.rule ? 1 : 0));
  return Result.succeed(plans);
};
