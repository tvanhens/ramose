/**
 * Pure core-v1 access-plan derivation.
 *
 * Walks a semantically validated rule and emits exactly one complete
 * {@link RuleAccessPlan}: field facts, entity/trait membership, card-one
 * hops, terminal membership (`index` for indexed many-scalars,
 * `refIndex` for many-refs), and principal-row resolution.
 * Database-wide `exists` lookups are not representable. Effect and
 * service lookup do not occur here.
 */

import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { canonicalizeJson } from "../canonical-json.ts";
import {
  RuleAccessLookup,
  type FieldDescriptor,
  type RuleAccessPlan,
} from "../catalog.ts";
import type { CanonicalAuthorizationExpr, CanonicalRefTerm, CanonicalValueTerm } from "../expr.ts";
import type { EntityId, FieldId, TraitId } from "../identities.ts";
import type { CanonicalAuthorizationRule } from "../ir.ts";
import type { JsonValue } from "../json.ts";
import type { InstalledPrincipalResolution } from "../principal.ts";
import {
  fieldAccessibleFrom,
  ownerFocus,
  requireField,
  type PreparedAuthorizationCatalog,
  type RowFocus,
} from "../validation/catalog.ts";
import { invalid, type ValidateFailure } from "../validation/common.ts";
import { rowFromRefTarget } from "../validation/types.ts";
import { meEntity, resourceFocus } from "../validation/traversal.ts";

const encodedJson = (encoded: unknown): JsonValue => encoded as JsonValue;

const encodeLookup = (lookup: RuleAccessLookup): string =>
  canonicalizeJson(encodedJson(Schema.encodeUnknownSync(RuleAccessLookup)(lookup)));

type TermUse = "value" | "collection" | "presence";

type PlanBuilder = {
  readonly seen: Map<string, RuleAccessLookup>;
};

const addLookup = (
  builder: PlanBuilder,
  lookup: RuleAccessLookup,
): Result.Result<void, ValidateFailure> => {
  let key: string;
  try {
    key = encodeLookup(lookup);
  } catch (cause) {
    return invalid(
      `ambiguous access-plan lookup: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  builder.seen.set(key, lookup);
  return Result.succeed(undefined);
};

const addEntity = (builder: PlanBuilder, entity: EntityId): Result.Result<void, ValidateFailure> =>
  addLookup(builder, { _tag: "entity", entity });

const addTrait = (builder: PlanBuilder, trait: TraitId): Result.Result<void, ValidateFailure> =>
  addLookup(builder, { _tag: "trait", trait });

const addField = (builder: PlanBuilder, field: FieldId): Result.Result<void, ValidateFailure> =>
  addLookup(builder, { _tag: "field", field });

const addIndex = (builder: PlanBuilder, field: FieldId): Result.Result<void, ValidateFailure> =>
  addLookup(builder, { _tag: "index", field });

const addRefIndex = (builder: PlanBuilder, field: FieldId): Result.Result<void, ValidateFailure> =>
  addLookup(builder, { _tag: "refIndex", field });

const addPrincipal = (builder: PlanBuilder, field: FieldId): Result.Result<void, ValidateFailure> =>
  addLookup(builder, { _tag: "principal", field });

const addMembership = (
  builder: PlanBuilder,
  focus: RowFocus,
): Result.Result<void, ValidateFailure> =>
  focus._tag === "entity" ? addEntity(builder, focus.entity) : addTrait(builder, focus.trait);

const fieldLabel = (field: FieldId): string =>
  `${field.owner.kind}:${field.owner.name}.${field.localName}`;

const requireIndexed = (field: FieldDescriptor): Result.Result<void, ValidateFailure> => {
  if (field.index) return Result.succeed(undefined);
  return invalid(`unrepresentable index for field '${fieldLabel(field.id)}'`);
};

const addTerminalMembership = (
  builder: PlanBuilder,
  field: FieldDescriptor,
): Result.Result<void, ValidateFailure> => {
  if (field.valueType === "ref") {
    return addRefIndex(builder, field.id);
  }
  const indexed = requireIndexed(field);
  if (Result.isFailure(indexed)) return Result.fail(indexed.failure);
  return addIndex(builder, field.id);
};

const walkRef = (
  index: PreparedAuthorizationCatalog,
  term: CanonicalRefTerm,
  resource: RowFocus,
  me: EntityId | undefined,
  use: TermUse,
  builder: PlanBuilder,
): Result.Result<void, ValidateFailure> => {
  let current: RowFocus;
  switch (term.root._tag) {
    case "resource":
      current = resource;
      break;
    case "me":
      if (me === undefined) {
        return invalid("omitted principal-row fact for me traversal");
      }
      current = { _tag: "entity", entity: me };
      break;
  }
  const membership = addMembership(builder, current);
  if (Result.isFailure(membership)) return Result.fail(membership.failure);

  if (term.steps.length === 0) return Result.succeed(undefined);

  for (let i = 0; i < term.steps.length; i++) {
    const step = term.steps[i]!;
    const field = requireField(index, step.field, "access-plan field");
    if (Result.isFailure(field)) return Result.fail(field.failure);
    if (!fieldAccessibleFrom(index, current, field.success)) {
      return invalid(`omitted field fact '${fieldLabel(step.field)}'`);
    }
    const fact = addField(builder, field.success.id);
    if (Result.isFailure(fact)) return Result.fail(fact.failure);

    const isLast = i === term.steps.length - 1;
    if (!isLast) {
      if (field.success.cardinality === "many") {
        return invalid("unrepresentable intermediate many-valued hop");
      }
      if (field.success.valueType !== "ref") {
        return invalid(`unrepresentable non-ref hop through '${fieldLabel(step.field)}'`);
      }
      const next = rowFromRefTarget(index, field.success.refTarget, field.success.id.owner);
      if (Result.isFailure(next)) return Result.fail(next.failure);
      if (next.success === undefined) {
        return invalid(`omitted hop target for '${fieldLabel(step.field)}'`);
      }
      current = next.success;
      const hopMembership = addMembership(builder, current);
      if (Result.isFailure(hopMembership)) return Result.fail(hopMembership.failure);
      continue;
    }

    if (field.success.cardinality === "many" && (use === "collection" || use === "presence")) {
      const terminal = addTerminalMembership(builder, field.success);
      if (Result.isFailure(terminal)) return Result.fail(terminal.failure);
    }
  }
  return Result.succeed(undefined);
};

const walkValue = (
  index: PreparedAuthorizationCatalog,
  term: CanonicalValueTerm,
  resource: RowFocus,
  me: EntityId | undefined,
  use: TermUse,
  builder: PlanBuilder,
): Result.Result<void, ValidateFailure> => {
  switch (term._tag) {
    case "ref":
      return walkRef(index, term, resource, me, use, builder);
    case "me":
    case "lit":
    case "subject":
    case "claim":
      return Result.succeed(undefined);
  }
};

const walkExpr = (
  index: PreparedAuthorizationCatalog,
  expr: CanonicalAuthorizationExpr,
  resource: RowFocus,
  me: EntityId | undefined,
  builder: PlanBuilder,
): Result.Result<void, ValidateFailure> => {
  switch (expr._tag) {
    case "const":
    case "hasClass":
      return Result.succeed(undefined);
    case "and":
    case "or": {
      for (const child of expr.exprs) {
        const part = walkExpr(index, child, resource, me, builder);
        if (Result.isFailure(part)) return Result.fail(part.failure);
      }
      return Result.succeed(undefined);
    }
    case "not":
      return walkExpr(index, expr.expr, resource, me, builder);
    case "eq": {
      const left = walkValue(index, expr.left, resource, me, "value", builder);
      if (Result.isFailure(left)) return Result.fail(left.failure);
      return walkValue(index, expr.right, resource, me, "value", builder);
    }
    case "has":
      return walkValue(index, expr.term, resource, me, "presence", builder);
    case "in": {
      const value = walkValue(index, expr.value, resource, me, "value", builder);
      if (Result.isFailure(value)) return Result.fail(value.failure);
      return walkValue(index, expr.collection, resource, me, "collection", builder);
    }
  }
};

const addPrincipalResolution = (
  index: PreparedAuthorizationCatalog,
  principal: InstalledPrincipalResolution,
  builder: PlanBuilder,
): Result.Result<void, ValidateFailure> => {
  if (principal.entity === undefined) {
    return invalid("omitted principal-row fact");
  }
  const field = requireField(index, principal.entity, "principal field");
  if (Result.isFailure(field)) return Result.fail(field.failure);
  if (field.success.unique === undefined) {
    return invalid("unrepresentable principal-row resolution: field is not unique");
  }
  const indexed = requireIndexed(field.success);
  if (Result.isFailure(indexed)) return Result.fail(indexed.failure);
  const owner = ownerFocus(index, field.success.id.owner);
  if (Result.isFailure(owner)) return Result.fail(owner.failure);
  const membership = addMembership(builder, owner.success);
  if (Result.isFailure(membership)) return Result.fail(membership.failure);
  const fact = addField(builder, field.success.id);
  if (Result.isFailure(fact)) return Result.fail(fact.failure);
  const indexLookup = addIndex(builder, field.success.id);
  if (Result.isFailure(indexLookup)) return Result.fail(indexLookup.failure);
  return addPrincipal(builder, field.success.id);
};

const addFocusMembership = (
  index: PreparedAuthorizationCatalog,
  rule: CanonicalAuthorizationRule,
  builder: PlanBuilder,
): Result.Result<void, ValidateFailure> => {
  const resource = resourceFocus(index, rule.focus);
  if (Result.isFailure(resource)) return Result.fail(resource.failure);
  const membership = addMembership(builder, resource.success);
  if (Result.isFailure(membership)) return Result.fail(membership.failure);
  if (rule.focus._tag === "field") {
    return addField(builder, rule.focus.field);
  }
  return Result.succeed(undefined);
};

export const deriveRuleAccessPlan = (
  index: PreparedAuthorizationCatalog,
  rule: CanonicalAuthorizationRule,
  principal: InstalledPrincipalResolution,
): Result.Result<RuleAccessPlan, ValidateFailure> => {
  const builder: PlanBuilder = { seen: new Map() };
  const resource = resourceFocus(index, rule.focus);
  if (Result.isFailure(resource)) return Result.fail(resource.failure);
  const me = meEntity(index, principal);
  if (Result.isFailure(me)) return Result.fail(me.failure);

  if (rule.usesResource) {
    const focus = addFocusMembership(index, rule, builder);
    if (Result.isFailure(focus)) return Result.fail(focus.failure);
  } else if (rule.focus._tag === "field") {
    const field = addField(builder, rule.focus.field);
    if (Result.isFailure(field)) return Result.fail(field.failure);
    const owner = ownerFocus(index, rule.focus.field.owner);
    if (Result.isFailure(owner)) return Result.fail(owner.failure);
    const membership = addMembership(builder, owner.success);
    if (Result.isFailure(membership)) return Result.fail(membership.failure);
  } else {
    const membership = addMembership(builder, resource.success);
    if (Result.isFailure(membership)) return Result.fail(membership.failure);
  }

  const walked = walkExpr(index, rule.expr, resource.success, me.success, builder);
  if (Result.isFailure(walked)) return Result.fail(walked.failure);

  if (rule.usesMe) {
    const resolved = addPrincipalResolution(index, principal, builder);
    if (Result.isFailure(resolved)) return Result.fail(resolved.failure);
  }

  const lookups = [...builder.seen.entries()]
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
    .map(([, lookup]) => lookup);
  return Result.succeed({ rule: rule.id, lookups });
};
