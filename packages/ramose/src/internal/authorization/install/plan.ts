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
  return Result.gen(function* () {
    yield* requireIndexed(field);
    return yield* addIndex(builder, field.id);
  });
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
  return Result.gen(function* () {
    yield* addMembership(builder, current);

    if (term.steps.length === 0) return;

    for (let i = 0; i < term.steps.length; i++) {
      const step = term.steps[i]!;
      const field = yield* requireField(index, step.field, "access-plan field");
      if (!fieldAccessibleFrom(index, current, field)) {
        return yield* invalid(`omitted field fact '${fieldLabel(step.field)}'`);
      }
      yield* addField(builder, field.id);

      const isLast = i === term.steps.length - 1;
      if (!isLast) {
        if (field.cardinality === "many") {
          return yield* invalid("unrepresentable intermediate many-valued hop");
        }
        if (field.valueType !== "ref") {
          return yield* invalid(`unrepresentable non-ref hop through '${fieldLabel(step.field)}'`);
        }
        const next = yield* rowFromRefTarget(index, field.refTarget, field.id.owner);
        if (next === undefined) {
          return yield* invalid(`omitted hop target for '${fieldLabel(step.field)}'`);
        }
        current = next;
        yield* addMembership(builder, current);
        continue;
      }

      if (field.cardinality === "many" && (use === "collection" || use === "presence")) {
        yield* addTerminalMembership(builder, field);
      }
    }
  });
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
    case "or":
      return Result.gen(function* () {
        for (const child of expr.exprs) {
          yield* walkExpr(index, child, resource, me, builder);
        }
      });
    case "not":
      return walkExpr(index, expr.expr, resource, me, builder);
    case "eq":
      return Result.gen(function* () {
        yield* walkValue(index, expr.left, resource, me, "value", builder);
        yield* walkValue(index, expr.right, resource, me, "value", builder);
      });
    case "has":
      return walkValue(index, expr.term, resource, me, "presence", builder);
    case "in":
      return Result.gen(function* () {
        yield* walkValue(index, expr.value, resource, me, "value", builder);
        yield* walkValue(index, expr.collection, resource, me, "collection", builder);
      });
  }
};

const addPrincipalResolution = (
  index: PreparedAuthorizationCatalog,
  principal: InstalledPrincipalResolution,
  builder: PlanBuilder,
): Result.Result<void, ValidateFailure> =>
  Result.gen(function* () {
    if (principal.entity === undefined) {
      return yield* invalid("omitted principal-row fact");
    }
    const field = yield* requireField(index, principal.entity, "principal field");
    if (field.unique === undefined) {
      return yield* invalid("unrepresentable principal-row resolution: field is not unique");
    }
    yield* requireIndexed(field);
    const owner = yield* ownerFocus(index, field.id.owner);
    yield* addMembership(builder, owner);
    yield* addField(builder, field.id);
    yield* addIndex(builder, field.id);
    return yield* addPrincipal(builder, field.id);
  });

const addFocusMembership = (
  index: PreparedAuthorizationCatalog,
  rule: CanonicalAuthorizationRule,
  builder: PlanBuilder,
): Result.Result<void, ValidateFailure> =>
  Result.gen(function* () {
    const resource = yield* resourceFocus(index, rule.focus);
    yield* addMembership(builder, resource);
    if (rule.focus._tag === "field") {
      yield* addField(builder, rule.focus.field);
    }
  });

export const deriveRuleAccessPlan = (
  index: PreparedAuthorizationCatalog,
  rule: CanonicalAuthorizationRule,
  principal: InstalledPrincipalResolution,
): Result.Result<RuleAccessPlan, ValidateFailure> =>
  Result.gen(function* () {
    const builder: PlanBuilder = { seen: new Map() };
    const resource = yield* resourceFocus(index, rule.focus);
    const me = yield* meEntity(index, principal);

    if (rule.focus._tag === "operation") {
    } else if (rule.usesResource) {
      yield* addFocusMembership(index, rule, builder);
    } else if (rule.focus._tag === "field") {
      yield* addField(builder, rule.focus.field);
      const owner = yield* ownerFocus(index, rule.focus.field.owner);
      yield* addMembership(builder, owner);
    } else {
      yield* addMembership(builder, resource);
    }

    yield* walkExpr(index, rule.expr, resource, me, builder);

    if (rule.usesMe) {
      yield* addPrincipalResolution(index, principal, builder);
    }

    const lookups = [...builder.seen.entries()]
      .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
      .map(([, lookup]) => lookup);
    return { rule: rule.id, lookups };
  });
