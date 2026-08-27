/**
 * Compile the read-authorization language into {@link PolicyTemplateIR} (#406).
 *
 * Pure kernel (`Result.gen`) lowers paths, merges decisions, and decodes
 * through Effect Schema. The Effect shell restamps rule identities with
 * {@link hashRelativeRule} — hashing stays out of the kernel.
 */

import { walkTraits, traitsOf } from "../../../db/compose.ts";
import type { AnySchema } from "../../../db/Schema.ts";
import { schemaTraits } from "../../../db/Schema.ts";
import { isSelfRefSchema, refTargetOf } from "../../../db/valueTypes.ts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { canonicalizeJson } from "../canonical-json.ts";
import { MAX_COLLECTION_SIZE, MAX_JSON_DEPTH, MAX_JSON_NODES, MAX_TRAVERSAL_DEPTH } from "../bounds.ts";
import {
  decodePolicyTemplateResult,
  encodePolicyTemplate,
  hashRelativeRule,
} from "../decode.ts";
import { InvalidIR } from "../failures.ts";
import { RuleId, type OwnerRef, type RelativeEntityId, type RelativeFieldId, type RelativeTraitId } from "../identities.ts";
import type {
  PolicyTemplateIR,
  RelativeAuthorizationRule,
  RelativeRuleFocus,
} from "../ir.ts";
import { POLICY_TEMPLATE_IR_VERSION, RelativeAuthorizationRule as RelativeAuthorizationRuleSchema } from "../ir.ts";
import type { JsonValue } from "../json.ts";
import type { ClaimDescriptor, ClaimShape, PrincipalResolutionConfig } from "../principal.ts";
import { AUTHORIZATION_LANGUAGE_VERSION } from "../version.ts";
import type {
  RelativeAuthorizationExpr,
  RelativeValueTerm,
} from "../expr.ts";
import {
  isEntityTarget,
  isJsonScalar,
  isPathCarrier,
  isTraitTarget,
  parseIdent,
  READ_RULE_TAG,
  stepFromCarrier,
  type AuthPathStep,
  type CompileReadAuthorizationInput,
  type ReadRule,
  type ReadTarget,
} from "./types.ts";

const SUPPORTED_EXPR_TAGS = new Set(["const", "hasClass", "and", "or", "not", "eq", "in"]);
const SUPPORTED_OPERAND_TAGS = new Set(["me", "subject", "claim", "lit", "path"]);

const invalid = (message: string): Result.Result<never, InvalidIR> =>
  Result.fail(new InvalidIR({ message }));

const clonePlain = <T>(value: T): T => {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => clonePlain(item)) as T;
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    copy[key] = clonePlain((value as Record<string, unknown>)[key]);
  }
  return copy as T;
};

const placeholderRuleId = (index: number): string => index.toString(16).padStart(64, "0");

const isEngineOwnedIdent = (ident: string): boolean => {
  if (ident === ":db/id") return true;
  const parsed = parseIdent(ident);
  return parsed !== undefined && (parsed.ns === "db" || parsed.ns === "ramose");
};

const ownerOfNamespace = (
  schema: AnySchema,
  ns: string,
): Result.Result<OwnerRef, InvalidIR> => {
  if (Object.hasOwn(schema.entities, ns)) {
    return Result.succeed({ kind: "entity", name: ns });
  }
  if (schemaTraits(schema).has(ns)) {
    return Result.succeed({ kind: "trait", name: ns });
  }
  return invalid(`invalid path: '${ns}' is not in this catalog`);
};

const schemaField = (
  schema: AnySchema,
  owner: OwnerRef,
  localName: string,
):
  | {
      readonly ident: string;
      readonly cardinality: "one" | "many";
      readonly valueType: string | undefined;
      readonly unique: string | undefined;
      readonly schema: unknown;
    }
  | undefined => {
  const fields =
    owner.kind === "entity"
      ? schema.entities[owner.name]?.fields
      : schemaTraits(schema).get(owner.name)?.fields;
  const field = fields?.[localName] as
    | {
        readonly ident?: unknown;
        readonly cardinality?: unknown;
        readonly valueType?: unknown;
        readonly unique?: unknown;
        readonly schema?: unknown;
      }
    | undefined;
  if (field === undefined || typeof field.ident !== "string") return undefined;
  return {
    ident: field.ident,
    cardinality: field.cardinality === "many" ? "many" : "one",
    valueType: typeof field.valueType === "string" ? field.valueType : undefined,
    unique: typeof field.unique === "string" ? field.unique : undefined,
    schema: field.schema,
  };
};

type RowCursor = OwnerRef;

type CompileShape =
  | { readonly _tag: "me" }
  | { readonly _tag: "subject" }
  | { readonly _tag: "claim"; readonly shape: ClaimShape | undefined }
  | { readonly _tag: "scalar"; readonly valueType: string; readonly cardinality?: "one" | "many" }
  | {
      readonly _tag: "ref";
      readonly targetNs: string | undefined;
      readonly targetKind?: "entity" | "trait";
      readonly cardinality?: "one" | "many";
    };

type NodeBudget = { nodes: number };

const takeNodes = (budget: NodeBudget, n: number): Result.Result<void, InvalidIR> => {
  budget.nodes += n;
  if (budget.nodes > MAX_JSON_NODES) {
    return invalid(`expression node budget ${budget.nodes} exceeds ${MAX_JSON_NODES}`);
  }
  return Result.succeed(undefined);
};

type LoweredOperand = {
  readonly term: RelativeValueTerm;
  readonly shape: CompileShape;
};

type Lowering = {
  readonly schema: AnySchema;
  readonly focus: RelativeRuleFocus;
  readonly claims: ReadonlyMap<string, ClaimDescriptor>;
  readonly principalEntity: string | undefined;
};

const rowFromFocus = (focus: RelativeRuleFocus): RowCursor => {
  switch (focus._tag) {
    case "entity":
      return { kind: "entity", name: focus.entity.name };
    case "trait":
      return { kind: "trait", name: focus.trait.name };
    case "field":
      return focus.field.owner;
  }
};

const composedTraitNames = (composer: unknown): ReadonlySet<string> => {
  const { all } = walkTraits(traitsOf(composer));
  return new Set(all.map((trait) => trait.ns));
};

const fieldAccessibleFrom = (
  schema: AnySchema,
  current: RowCursor,
  owner: OwnerRef,
): boolean => {
  if (current.kind === "entity") {
    if (owner.kind === "entity") return owner.name === current.name;
    const entity = schema.entities[current.name];
    return entity !== undefined && composedTraitNames(entity).has(owner.name);
  }
  if (owner.kind === "entity") return false;
  if (owner.name === current.name) return true;
  const trait = schemaTraits(schema).get(current.name);
  return trait !== undefined && composedTraitNames(trait).has(owner.name);
};

const resolveCompileRef = (
  schema: AnySchema,
  fieldSchema: unknown,
  fieldOwner: OwnerRef,
): Result.Result<
  { readonly targetNs: string | undefined; readonly targetKind?: "entity" | "trait" },
  InvalidIR
> =>
  Result.gen(function* () {
    if (isSelfRefSchema(fieldSchema)) {
      return { targetNs: fieldOwner.name, targetKind: fieldOwner.kind };
    }
    const ns = refTargetOf(fieldSchema)?.()?.ns;
    if (typeof ns !== "string") return { targetNs: undefined };
    const owner = yield* ownerOfNamespace(schema, ns);
    return { targetNs: owner.name, targetKind: owner.kind };
  });

const nextRowFromRef = (
  schema: AnySchema,
  fieldSchema: unknown,
  fieldOwner: OwnerRef,
  ident: string,
): Result.Result<RowCursor, InvalidIR> =>
  Result.gen(function* () {
    const target = yield* resolveCompileRef(schema, fieldSchema, fieldOwner);
    if (target.targetNs === undefined || target.targetKind === undefined) {
      return yield* invalid(`cannot traverse from an untargeted ref through '${ident}'`);
    }
    return { kind: target.targetKind, name: target.targetNs };
  });

const rowOfRef = (
  shape: Extract<CompileShape, { readonly _tag: "ref" }>,
): { readonly kind: "entity" | "trait"; readonly name: string } | undefined => {
  if (shape.targetNs === undefined) return undefined;
  return { kind: shape.targetKind ?? "entity", name: shape.targetNs };
};

const sameRow = (
  schema: AnySchema,
  left: { readonly kind: "entity" | "trait"; readonly name: string },
  right: { readonly kind: "entity" | "trait"; readonly name: string },
): boolean => {
  if (left.kind === "entity" && right.kind === "entity") {
    return left.name === right.name;
  }
  if (left.kind === "trait" && right.kind === "trait") {
    if (left.name === right.name) return true;
    const leftTrait = schemaTraits(schema).get(left.name);
    const rightTrait = schemaTraits(schema).get(right.name);
    return (
      (leftTrait !== undefined && composedTraitNames(leftTrait).has(right.name)) ||
      (rightTrait !== undefined && composedTraitNames(rightTrait).has(left.name))
    );
  }
  const entityName = left.kind === "entity" ? left.name : right.name;
  const traitName = left.kind === "trait" ? left.name : right.name;
  const entity = schema.entities[entityName];
  return entity !== undefined && composedTraitNames(entity).has(traitName);
};

const sameRefTarget = (
  schema: AnySchema,
  left: Extract<CompileShape, { readonly _tag: "ref" }>,
  right: Extract<CompileShape, { readonly _tag: "ref" }>,
): boolean => {
  const leftUntargeted = left.targetNs === undefined;
  const rightUntargeted = right.targetNs === undefined;
  if (leftUntargeted && rightUntargeted) return true;
  if (leftUntargeted || rightUntargeted) return false;
  const leftRow = rowOfRef(left);
  const rightRow = rowOfRef(right);
  return leftRow !== undefined && rightRow !== undefined && sameRow(schema, leftRow, rightRow);
};

const meCompatibleWith = (
  schema: AnySchema,
  principalEntity: string | undefined,
  other: CompileShape,
): boolean => {
  if (other._tag === "me") return true;
  if (other._tag !== "ref") return false;
  const focus = rowOfRef(other);
  return (
    focus !== undefined &&
    (principalEntity === undefined || sameRow(schema, { kind: "entity", name: principalEntity }, focus))
  );
};

const litShape = (value: string | number | boolean | null): CompileShape => {
  if (value === null) return { _tag: "scalar", valueType: "null" };
  if (typeof value === "boolean") return { _tag: "scalar", valueType: "boolean" };
  if (typeof value === "number") return { _tag: "scalar", valueType: "number" };
  return { _tag: "scalar", valueType: "string" };
};

const scalarAssignable = (expected: string, actual: CompileShape): boolean => {
  if (actual._tag === "subject") return expected === "string";
  if (actual._tag !== "scalar") return false;
  if (expected === actual.valueType) return true;
  if (expected === "number") return actual.valueType === "long" || actual.valueType === "double";
  if (actual.valueType === "number") return expected === "long" || expected === "double";
  if (expected === "string" && actual.valueType === "uuid") return true;
  if (expected === "uuid" && actual.valueType === "string") return true;
  return false;
};

const eqCompatible = (
  schema: AnySchema,
  left: CompileShape,
  right: CompileShape,
  principalEntity: string | undefined,
): boolean => {
  const pair = (a: CompileShape, b: CompileShape): boolean => {
    if (a._tag === "me") return meCompatibleWith(schema, principalEntity, b);
    if (a._tag === "subject") {
      if (b._tag === "subject") return true;
      if (scalarAssignable("string", b)) return true;
      if (b._tag === "claim") {
        if (b.shape === undefined) return true;
        return b.shape._tag === "scalar" && scalarAssignable("string", {
          _tag: "scalar",
          valueType: b.shape.valueType,
        });
      }
      return false;
    }
    if (a._tag === "ref") {
      if (b._tag === "ref") return sameRefTarget(schema, a, b);
      return false;
    }
    if (a._tag === "scalar") {
      if (b._tag === "scalar") return scalarAssignable(a.valueType, b);
      if (b._tag === "claim") {
        if (b.shape === undefined) return true;
        return (
          b.shape._tag === "scalar" &&
          scalarAssignable(a.valueType, { _tag: "scalar", valueType: b.shape.valueType })
        );
      }
      return false;
    }
    if (a._tag === "claim") {
      if (a.shape === undefined) return true;
      if (a.shape._tag !== "scalar") return false;
      return pair({ _tag: "scalar", valueType: a.shape.valueType }, b);
    }
    return false;
  };
  return pair(left, right) || pair(right, left);
};

const compileRef = (
  targetNs: string | undefined,
  targetKind: "entity" | "trait" | undefined,
  cardinality: "one" | "many",
): Extract<CompileShape, { readonly _tag: "ref" }> =>
  targetKind === undefined
    ? { _tag: "ref", targetNs, cardinality }
    : { _tag: "ref", targetNs, targetKind, cardinality };

const membershipElement = (shape: CompileShape): CompileShape | undefined => {
  if (shape._tag === "ref" && shape.cardinality === "many") {
    return compileRef(shape.targetNs, shape.targetKind, "one");
  }
  if (shape._tag === "scalar" && shape.cardinality === "many") {
    return { _tag: "scalar", valueType: shape.valueType, cardinality: "one" };
  }
  if (shape._tag === "claim" && shape.shape !== undefined && shape.shape._tag === "array") {
    return { _tag: "claim", shape: shape.shape.items };
  }
  return undefined;
};

const principalEntityName = (
  principal: CompileReadAuthorizationInput["principal"],
): string | undefined => {
  if (principal?.entity === undefined) return undefined;
  return parseIdent(principal.entity.ident)?.ns;
};

const lowerFieldId = (
  schema: AnySchema,
  step: AuthPathStep,
): Result.Result<
  {
    readonly id: { readonly _tag: "RelativeFieldId"; readonly owner: OwnerRef; readonly localName: string };
    readonly cardinality: "one" | "many";
    readonly valueType: string | undefined;
    readonly unique: string | undefined;
    readonly schema: unknown;
  },
  InvalidIR
> =>
  Result.gen(function* () {
    if (step.ident === "" || step.localName === "") {
      return yield* invalid("invalid path");
    }
    if (isEngineOwnedIdent(step.ident)) {
      return yield* invalid(`engine-owned ident '${step.ident}' is not a readable path`);
    }
    if (step.reverse) {
      return yield* invalid(`reverse path '${step.ident}' is not supported`);
    }
    const parsed = parseIdent(step.ident);
    if (parsed === undefined) {
      return yield* invalid(`invalid path '${step.ident}'`);
    }
    const localName = step.localName !== "" ? step.localName : parsed.localName;
    const owner = yield* ownerOfNamespace(schema, parsed.ns);
    const field = schemaField(schema, owner, localName);
    if (field === undefined || field.ident !== step.ident) {
      return yield* invalid(`unknown field path '${step.ident}' is not in this catalog`);
    }
    return {
      id: { _tag: "RelativeFieldId" as const, owner, localName },
      cardinality: field.cardinality,
      valueType: field.valueType,
      unique: field.unique,
      schema: field.schema,
    };
  });

const lowerPathSteps = (
  ctx: Lowering,
  steps: readonly AuthPathStep[],
  role: "eq" | "contains-collection" | "contains-value" | "term",
  budget: NodeBudget,
): Result.Result<LoweredOperand, InvalidIR> =>
  Result.gen(function* () {
    if (steps.length === 0) {
      return yield* invalid("invalid path: empty traversal");
    }
    if (steps.length > MAX_COLLECTION_SIZE) {
      return yield* invalid(
        `path collection size ${steps.length} exceeds ${MAX_COLLECTION_SIZE}`,
      );
    }
    if (steps.length > MAX_TRAVERSAL_DEPTH) {
      return yield* invalid(
        `traversal depth ${steps.length} exceeds ${MAX_TRAVERSAL_DEPTH}`,
      );
    }
    yield* takeNodes(budget, 1 + steps.length);
    const lowered: { readonly field: RelativeFieldId }[] = [];
    let current = rowFromFocus(ctx.focus);
    let terminal: CompileShape = { _tag: "scalar", valueType: "string" };
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      const field = yield* lowerFieldId(ctx.schema, step);
      if (!fieldAccessibleFrom(ctx.schema, current, field.id.owner)) {
        return yield* invalid(
          `wrong owner for field '${field.id.owner.kind}:${field.id.owner.name}.${field.id.localName}'`,
        );
      }
      const isLast = i === steps.length - 1;
      if (!isLast) {
        if (field.cardinality === "many") {
          return yield* invalid(
            `intermediate many-valued hop '${step.ident}' is not supported`,
          );
        }
        if (field.valueType !== "ref") {
          return yield* invalid(
            `intermediate hop '${step.ident}' is not a ref`,
          );
        }
        current = yield* nextRowFromRef(ctx.schema, field.schema, field.id.owner, step.ident);
      } else if (role === "eq" && field.cardinality === "many") {
        return yield* invalid(
          `eq cannot compare card-many path '${step.ident}'; use contains`,
        );
      } else if (role === "contains-collection" && field.cardinality !== "many") {
        return yield* invalid(
          `contains requires a card-many collection at the terminal hop ('${step.ident}')`,
        );
      } else if (role === "contains-value" && field.cardinality === "many") {
        return yield* invalid(
          `contains value cannot be card-many path '${step.ident}'`,
        );
      }
      if (isLast) {
        if (field.valueType === "ref") {
          const target = yield* resolveCompileRef(ctx.schema, field.schema, field.id.owner);
          terminal = compileRef(target.targetNs, target.targetKind, field.cardinality);
        } else {
          terminal = {
            _tag: "scalar",
            valueType: field.valueType ?? "string",
            cardinality: field.cardinality,
          };
        }
      }
      lowered.push({ field: field.id });
    }
    return {
      term: {
        _tag: "ref" as const,
        root: { _tag: "resource" as const },
        steps: lowered,
      },
      shape: terminal,
    };
  });

const readPathSteps = (input: unknown): Result.Result<readonly AuthPathStep[], InvalidIR> => {
  const steps = (input as { readonly steps?: unknown }).steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    return invalid("malformed path");
  }
  if (steps.length > MAX_COLLECTION_SIZE) {
    return invalid(`path collection size ${steps.length} exceeds ${MAX_COLLECTION_SIZE}`);
  }
  const checked: AuthPathStep[] = [];
  for (const step of steps) {
    if (typeof step !== "object" || step === null) {
      return invalid("malformed path");
    }
    const ident = (step as { readonly ident?: unknown }).ident;
    if (typeof ident !== "string") {
      return invalid("malformed path");
    }
    const parsed = parseIdent(ident);
    const localNameRaw = (step as { readonly localName?: unknown }).localName;
    const localName =
      typeof localNameRaw === "string" && localNameRaw !== ""
        ? localNameRaw
        : (parsed?.localName ?? "");
    const valueType = (step as { readonly valueType?: unknown }).valueType;
    checked.push({
      ident,
      localName,
      cardinality: (step as { readonly cardinality?: unknown }).cardinality === "many" ? "many" : "one",
      valueType: typeof valueType === "string" ? valueType : undefined,
      reverse: (step as { readonly reverse?: unknown }).reverse === true,
    });
  }
  return Result.succeed(checked);
};

const lowerOperand = (
  ctx: Lowering,
  input: unknown,
  role: "eq" | "contains-collection" | "contains-value" | "term",
  budget: NodeBudget,
): Result.Result<LoweredOperand, InvalidIR> =>
  Result.gen(function* () {
    if (typeof input !== "object" || input === null) {
      return yield* invalid("unsupported operand");
    }
    const tag = (input as { readonly _tag?: unknown })._tag;
    if (typeof tag !== "string" || !SUPPORTED_OPERAND_TAGS.has(tag)) {
      return yield* invalid(
        `unsupported operand tag '${typeof tag === "string" ? tag : "unknown"}'`,
      );
    }
    yield* takeNodes(budget, 1);
    switch (tag) {
      case "me":
        return { term: { _tag: "me" as const }, shape: { _tag: "me" as const } };
      case "subject":
        return { term: { _tag: "subject" as const }, shape: { _tag: "subject" as const } };
      case "claim": {
        const key = (input as { readonly key?: unknown }).key;
        if (typeof key !== "string") {
          return yield* invalid("malformed claim");
        }
        if (key.length === 0) {
          return yield* invalid("blank claim key");
        }
        return {
          term: { _tag: "claim" as const, key },
          shape: { _tag: "claim" as const, shape: ctx.claims.get(key)?.shape },
        };
      }
      case "lit": {
        const value = (input as { readonly value?: unknown }).value;
        if (!isJsonScalar(value)) {
          return yield* invalid("literal is not a JSON scalar");
        }
        return { term: { _tag: "lit" as const, value }, shape: litShape(value) };
      }
      case "path":
        return yield* lowerPathSteps(ctx, yield* readPathSteps(input), role, budget);
      default:
        return yield* invalid(`unsupported operand tag '${tag}'`);
    }
  });

type LoweredExpr = {
  readonly expr: RelativeAuthorizationExpr;
  readonly classes: readonly string[];
  readonly claims: readonly string[];
};

const mergeUnique = (into: string[], extras: readonly string[]): void => {
  for (const item of extras) {
    if (!into.includes(item)) into.push(item);
  }
};

const lowerExpr = (
  ctx: Lowering,
  input: unknown,
  budget: NodeBudget,
  depth = 0,
): Result.Result<LoweredExpr, InvalidIR> =>
  Result.gen(function* () {
    if (depth > MAX_JSON_DEPTH) {
      return yield* invalid(`expression depth ${depth} exceeds ${MAX_JSON_DEPTH}`);
    }
    if (typeof input !== "object" || input === null) {
      return yield* invalid("unsupported expression");
    }
    const tag = (input as { readonly _tag?: unknown })._tag;
    if (typeof tag !== "string" || !SUPPORTED_EXPR_TAGS.has(tag)) {
      return yield* invalid(
        `unsupported expression tag '${typeof tag === "string" ? tag : "unknown"}'`,
      );
    }
    yield* takeNodes(budget, 1);
    const record = input as Record<string, unknown>;
    switch (tag) {
      case "const": {
        const value = record.value;
        if (typeof value !== "boolean") {
          return yield* invalid("malformed const");
        }
        return { expr: { _tag: "const" as const, value }, classes: [], claims: [] };
      }
      case "hasClass": {
        const className = record.class;
        if (typeof className !== "string") {
          return yield* invalid("malformed hasClass");
        }
        if (className.length === 0) {
          return yield* invalid("blank class name");
        }
        return {
          expr: { _tag: "hasClass" as const, class: className },
          classes: [className],
          claims: [],
        };
      }
      case "and":
      case "or": {
        const exprs = record.exprs;
        if (!Array.isArray(exprs)) {
          return yield* invalid(tag === "and" ? "malformed all" : "malformed any");
        }
        if (exprs.length === 0) {
          return yield* invalid(tag === "and" ? "empty all() is invalid" : "empty any() is invalid");
        }
        if (exprs.length > MAX_COLLECTION_SIZE) {
          return yield* invalid(
            `expression collection size ${exprs.length} exceeds ${MAX_COLLECTION_SIZE}`,
          );
        }
        yield* takeNodes(budget, 1 + exprs.length);
        const children: RelativeAuthorizationExpr[] = [];
        const classes: string[] = [];
        const claims: string[] = [];
        for (const child of exprs) {
          if (depth + 1 > MAX_JSON_DEPTH) {
            return yield* invalid(`expression depth ${depth + 1} exceeds ${MAX_JSON_DEPTH}`);
          }
          if (budget.nodes >= MAX_JSON_NODES) {
            return yield* invalid(
              `expression node budget ${budget.nodes + 1} exceeds ${MAX_JSON_NODES}`,
            );
          }
          const lowered = yield* lowerExpr(ctx, child, budget, depth + 1);
          children.push(lowered.expr);
          mergeUnique(classes, lowered.classes);
          mergeUnique(claims, lowered.claims);
        }
        return {
          expr:
            tag === "and"
              ? { _tag: "and" as const, exprs: children }
              : { _tag: "or" as const, exprs: children },
          classes,
          claims,
        };
      }
      case "not": {
        const childExpr = record.expr;
        if (typeof childExpr !== "object" || childExpr === null) {
          return yield* invalid("malformed not");
        }
        if (depth + 1 > MAX_JSON_DEPTH) {
          return yield* invalid(`expression depth ${depth + 1} exceeds ${MAX_JSON_DEPTH}`);
        }
        const child = yield* lowerExpr(ctx, childExpr, budget, depth + 1);
        return {
          expr: { _tag: "not" as const, expr: child.expr },
          classes: child.classes,
          claims: child.claims,
        };
      }
      case "eq": {
        const leftInput = record.left;
        const rightInput = record.right;
        if (
          leftInput === undefined ||
          leftInput === null ||
          rightInput === undefined ||
          rightInput === null
        ) {
          return yield* invalid("malformed eq");
        }
        const left = yield* lowerOperand(ctx, leftInput, "eq", budget);
        const right = yield* lowerOperand(ctx, rightInput, "eq", budget);
        if (!eqCompatible(ctx.schema, left.shape, right.shape, ctx.principalEntity)) {
          return yield* invalid("incompatible equality operands");
        }
        return {
          expr: { _tag: "eq" as const, left: left.term, right: right.term },
          classes: [],
          claims: claimKeysOf([left.term, right.term]),
        };
      }
      case "in": {
        const valueInput = record.value;
        const collectionInput = record.collection;
        if (
          valueInput === undefined ||
          valueInput === null ||
          collectionInput === undefined ||
          collectionInput === null
        ) {
          return yield* invalid("malformed contains");
        }
        const collection = yield* lowerOperand(ctx, collectionInput, "contains-collection", budget);
        const value = yield* lowerOperand(ctx, valueInput, "contains-value", budget);
        const element = membershipElement(collection.shape);
        if (element === undefined) {
          return yield* invalid("membership requires a collection");
        }
        if (!eqCompatible(ctx.schema, value.shape, element, ctx.principalEntity)) {
          return yield* invalid("incompatible membership operands");
        }
        return {
          expr: { _tag: "in" as const, value: value.term, collection: collection.term },
          classes: [],
          claims: claimKeysOf([value.term, collection.term]),
        };
      }
      default:
        return yield* invalid(`unsupported expression tag '${tag}'`);
    }
  });

const claimKeysOf = (terms: readonly RelativeValueTerm[]): readonly string[] => {
  const keys: string[] = [];
  for (const term of terms) {
    if (term._tag === "claim" && !keys.includes(term.key)) keys.push(term.key);
  }
  return keys;
};

type DerivedFlags = {
  usesResource: boolean;
  usesMe: boolean;
  usesSubject: boolean;
  traversalDepth: number;
};

const emptyFlags = (): DerivedFlags => ({
  usesResource: false,
  usesMe: false,
  usesSubject: false,
  traversalDepth: 0,
});

const mergeFlags = (into: DerivedFlags, part: DerivedFlags): void => {
  into.usesResource ||= part.usesResource;
  into.usesMe ||= part.usesMe;
  into.usesSubject ||= part.usesSubject;
  if (part.traversalDepth > into.traversalDepth) into.traversalDepth = part.traversalDepth;
};

const flagsOfTerm = (term: RelativeValueTerm): DerivedFlags => {
  const flags = emptyFlags();
  switch (term._tag) {
    case "me":
      flags.usesMe = true;
      return flags;
    case "subject":
      flags.usesSubject = true;
      return flags;
    case "lit":
    case "claim":
      return flags;
    case "ref":
      if (term.root._tag === "resource") flags.usesResource = true;
      if (term.root._tag === "me") flags.usesMe = true;
      flags.traversalDepth = term.steps.length;
      return flags;
  }
};

const deriveFlags = (expr: RelativeAuthorizationExpr): DerivedFlags => {
  const flags = emptyFlags();
  switch (expr._tag) {
    case "const":
    case "hasClass":
      return flags;
    case "and":
    case "or":
      for (const child of expr.exprs) mergeFlags(flags, deriveFlags(child));
      return flags;
    case "not":
      return deriveFlags(expr.expr);
    case "eq":
      mergeFlags(flags, flagsOfTerm(expr.left));
      mergeFlags(flags, flagsOfTerm(expr.right));
      return flags;
    case "has":
      return flagsOfTerm(expr.term);
    case "in":
      mergeFlags(flags, flagsOfTerm(expr.value));
      mergeFlags(flags, flagsOfTerm(expr.collection));
      return flags;
  }
};

const lowerFocus = (
  schema: AnySchema,
  target: ReadTarget,
): Result.Result<RelativeRuleFocus, InvalidIR> =>
  Result.gen(function* () {
    if (isEntityTarget(target)) {
      if (!Object.hasOwn(schema.entities, target.ns)) {
        return yield* invalid(`entity '${target.ns}' is not in this catalog`);
      }
      return {
        _tag: "entity" as const,
        entity: { _tag: "RelativeEntityId" as const, name: target.ns },
      };
    }
    if (isTraitTarget(target)) {
      if (!schemaTraits(schema).has(target.ns)) {
        return yield* invalid(`trait '${target.ns}' is not in this catalog`);
      }
      return {
        _tag: "trait" as const,
        trait: { _tag: "RelativeTraitId" as const, name: target.ns },
      };
    }
    if (isPathCarrier(target)) {
      const field = yield* lowerFieldId(schema, stepFromCarrier(target));
      return { _tag: "field" as const, field: field.id };
    }
    return yield* invalid("read() target must be an Entity, Trait, or stamped field");
  });

const focusTargetKey = (focus: RelativeRuleFocus): string => {
  switch (focus._tag) {
    case "entity":
      return `entity\0${focus.entity.name}`;
    case "trait":
      return `trait\0${focus.trait.name}`;
    case "field":
      return `field\0${focus.field.owner.kind}\0${focus.field.owner.name}\0${focus.field.localName}`;
  }
};

const focusTarget = (
  focus: RelativeRuleFocus,
): RelativeEntityId | RelativeTraitId | RelativeFieldId => {
  switch (focus._tag) {
    case "entity":
      return focus.entity;
    case "trait":
      return focus.trait;
    case "field":
      return focus.field;
  }
};

const ruleBodyKey = (rule: RelativeAuthorizationRule): Result.Result<string, InvalidIR> => {
  try {
    const encoded = Schema.encodeUnknownSync(RelativeAuthorizationRuleSchema)(rule);
    if (typeof encoded !== "object" || encoded === null || Array.isArray(encoded)) {
      return invalid("failed to encode rule body");
    }
    const body: Record<string, JsonValue> = {};
    for (const key of Object.keys(encoded)) {
      if (key !== "id") body[key] = (encoded as Record<string, JsonValue>)[key]!;
    }
    return Result.succeed(canonicalizeJson(body));
  } catch (cause) {
    return invalid(
      `failed to encode rule body: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
};

const lowerPrincipal = (
  schema: AnySchema,
  principal: CompileReadAuthorizationInput["principal"],
): Result.Result<PrincipalResolutionConfig, InvalidIR> =>
  Result.gen(function* () {
    const subjectClaim = principal?.subjectClaim ?? "sub";
    if (subjectClaim.length === 0) {
      return yield* invalid("blank principal subject claim");
    }
    if (principal?.entity === undefined) {
      return { subjectClaim };
    }
    const field = yield* lowerFieldId(schema, stepFromCarrier(principal.entity));
    if (field.id.owner.kind !== "entity") {
      return yield* invalid("principal field must be entity-owned");
    }
    if (field.unique === undefined) {
      return yield* invalid("principal field is not unique");
    }
    if (field.valueType !== "string" && field.valueType !== "uuid") {
      return yield* invalid("principal field must be string-compatible");
    }
    return { subjectClaim, entity: field.id };
  });

const requireReadRule = (rule: unknown): Result.Result<ReadRule, InvalidIR> => {
  if (
    typeof rule !== "object" ||
    rule === null ||
    (rule as { readonly _tag?: unknown })._tag !== READ_RULE_TAG
  ) {
    return invalid("rules must be produced by read().when / read().deny");
  }
  return Result.succeed(rule as ReadRule);
};

type DecisionBucket = {
  readonly target: ReturnType<typeof focusTarget>;
  readonly focusKey: string;
  readonly allow: RuleId[];
  readonly deny: RuleId[];
};

/**
 * Pure compile kernel. Placeholder rule ids are structurally valid
 * 64-hex digests; the Effect shell restamps them with {@link hashRelativeRule}.
 */
export const compileReadAuthorizationResult = (
  input: CompileReadAuthorizationInput,
): Result.Result<PolicyTemplateIR, InvalidIR> =>
  Result.gen(function* () {
    const declaredClaims = input.claims ?? [];
    const declaredClaimKeys = new Set(declaredClaims.map((claim) => claim.key));
    const classes: string[] = [...(input.classes ?? [])];
    const seenClass = new Set(classes);
    for (const name of classes) {
      if (name.length === 0) return yield* invalid("blank class name");
    }
    if (seenClass.size !== classes.length) {
      return yield* invalid("duplicate class");
    }

    if (input.rules.length > MAX_COLLECTION_SIZE) {
      return yield* invalid(
        `rule collection size ${input.rules.length} exceeds ${MAX_COLLECTION_SIZE}`,
      );
    }

    const rules: RelativeAuthorizationRule[] = [];
    const bodies = new Set<string>();
    const buckets = new Map<string, DecisionBucket>();
    const claimByKey = new Map(declaredClaims.map((claim) => [claim.key, claim]));
    const principalEntity = principalEntityName(input.principal);
    const documentBudget: NodeBudget = { nodes: 0 };

    for (let i = 0; i < input.rules.length; i++) {
      const authored = yield* requireReadRule(input.rules[i]);
      const focus = yield* lowerFocus(input.schema, authored.target);
      const lowered = yield* lowerExpr(
        {
          schema: input.schema,
          focus,
          claims: claimByKey,
          principalEntity,
        },
        authored.expr,
        documentBudget,
      );
      for (const key of lowered.claims) {
        if (!declaredClaimKeys.has(key)) {
          return yield* invalid(`undeclared claim '${key}'`);
        }
      }
      for (const name of lowered.classes) {
        if (!seenClass.has(name)) {
          if (name.length === 0) return yield* invalid("blank class name");
          seenClass.add(name);
          classes.push(name);
        }
      }
      const flags = deriveFlags(lowered.expr);
      const id = RuleId.make(placeholderRuleId(i));
      const rule = {
        id,
        focus,
        expr: lowered.expr,
        usesResource: flags.usesResource,
        usesMe: flags.usesMe,
        usesSubject: flags.usesSubject,
        traversalDepth: flags.traversalDepth,
      } as RelativeAuthorizationRule;
      const body = yield* ruleBodyKey(rule);
      if (bodies.has(body)) {
        return yield* invalid("duplicate identical rule body");
      }
      bodies.add(body);
      rules.push(rule);

      const key = focusTargetKey(focus);
      const existing = buckets.get(key);
      if (existing === undefined) {
        buckets.set(key, {
          target: focusTarget(focus),
          focusKey: key,
          allow: [],
          deny: [],
        });
      }
      const bucket = buckets.get(key)!;
      if (authored.kind === "allow") bucket.allow.push(id);
      else bucket.deny.push(id);
    }

    const entities: Array<{
      readonly target: RelativeEntityId;
      readonly decision: { readonly allow: readonly RuleId[]; readonly deny: readonly RuleId[] };
    }> = [];
    const traits: Array<{
      readonly target: RelativeTraitId;
      readonly decision: { readonly allow: readonly RuleId[]; readonly deny: readonly RuleId[] };
    }> = [];
    const fields: Array<{
      readonly target: RelativeFieldId;
      readonly decision: { readonly allow: readonly RuleId[]; readonly deny: readonly RuleId[] };
    }> = [];
    for (const bucket of buckets.values()) {
      const decision = { allow: bucket.allow, deny: bucket.deny };
      if (bucket.focusKey.startsWith("entity\0")) {
        entities.push({ target: bucket.target as RelativeEntityId, decision });
      } else if (bucket.focusKey.startsWith("trait\0")) {
        traits.push({ target: bucket.target as RelativeTraitId, decision });
      } else {
        fields.push({ target: bucket.target as RelativeFieldId, decision });
      }
    }
    const decisions = { entities, traits, fields };

    const principal = yield* lowerPrincipal(input.schema, input.principal);
    const document = {
      _tag: "PolicyTemplateIR" as const,
      version: POLICY_TEMPLATE_IR_VERSION,
      languageVersion: AUTHORIZATION_LANGUAGE_VERSION,
      classes,
      claims: declaredClaims,
      principal,
      rules,
      decisions,
    };
    return yield* decodePolicyTemplateResult(clonePlain(document));
  });

const remapRuleIds = (
  ids: readonly RuleId[],
  map: ReadonlyMap<RuleId, RuleId>,
): readonly RuleId[] => ids.map((id) => map.get(id) ?? id);

/**
 * Effect shell: compile, restamp every rule id with {@link hashRelativeRule},
 * rewrite decision lists, and decode again so Schema remains the source of truth.
 */
export const compileReadAuthorization = Effect.fn("Authorization.compileReadAuthorization")(
  function* (
    input: CompileReadAuthorizationInput,
  ): Effect.fn.Return<PolicyTemplateIR, InvalidIR> {
    const template = yield* Effect.fromResult(compileReadAuthorizationResult(input));
    const idMap = new Map<RuleId, RuleId>();
    const rules: PolicyTemplateIR["rules"][number][] = [];
    for (const rule of template.rules) {
      const id = yield* hashRelativeRule(rule);
      idMap.set(rule.id, id);
      rules.push({ ...rule, id });
    }
    const restamped: PolicyTemplateIR = {
      ...template,
      rules,
      decisions: {
        entities: template.decisions.entities.map((entry) => ({
          ...entry,
          decision: {
            allow: remapRuleIds(entry.decision.allow, idMap),
            deny: remapRuleIds(entry.decision.deny, idMap),
          },
        })),
        traits: template.decisions.traits.map((entry) => ({
          ...entry,
          decision: {
            allow: remapRuleIds(entry.decision.allow, idMap),
            deny: remapRuleIds(entry.decision.deny, idMap),
          },
        })),
        fields: template.decisions.fields.map((entry) => ({
          ...entry,
          decision: {
            allow: remapRuleIds(entry.decision.allow, idMap),
            deny: remapRuleIds(entry.decision.deny, idMap),
          },
        })),
      },
    };
    return yield* Effect.fromResult(
      decodePolicyTemplateResult(clonePlain(encodePolicyTemplate(restamped))),
    );
  },
);
