/**
 * Compile the read-authorization language into {@link PolicyTemplateIR} (#406).
 *
 * Pure kernel (`Result.gen`) lowers paths, merges decisions, and decodes
 * through Effect Schema. The Effect shell restamps rule identities with
 * {@link hashRelativeRule} — hashing stays out of the kernel.
 */

import type { AnySchema } from "../../../db/Schema.ts";
import { schemaTraits } from "../../../db/Schema.ts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { canonicalizeJson } from "../canonical-json.ts";
import { MAX_TRAVERSAL_DEPTH } from "../bounds.ts";
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
import type { PrincipalResolutionConfig } from "../principal.ts";
import { AUTHORIZATION_LANGUAGE_VERSION } from "../version.ts";
import type {
  RelativeAuthorizationExpr,
  RelativeValueTerm,
} from "../expr.ts";
import {
  isEntityTarget,
  isPathCarrier,
  isTraitTarget,
  parseIdent,
  READ_RULE_TAG,
  stepFromCarrier,
  type AuthExpr,
  type AuthPathStep,
  type BoxedOperand,
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
      }
    | undefined;
  if (field === undefined || typeof field.ident !== "string") return undefined;
  return {
    ident: field.ident,
    cardinality: field.cardinality === "many" ? "many" : "one",
    valueType: typeof field.valueType === "string" ? field.valueType : undefined,
    unique: typeof field.unique === "string" ? field.unique : undefined,
  };
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
    };
  });

const lowerPathSteps = (
  schema: AnySchema,
  steps: readonly AuthPathStep[],
  role: "eq" | "contains-collection" | "contains-value" | "term",
): Result.Result<RelativeValueTerm, InvalidIR> =>
  Result.gen(function* () {
    if (steps.length === 0) {
      return yield* invalid("invalid path: empty traversal");
    }
    if (steps.length > MAX_TRAVERSAL_DEPTH) {
      return yield* invalid(
        `traversal depth ${steps.length} exceeds ${MAX_TRAVERSAL_DEPTH}`,
      );
    }
    const lowered: { readonly field: RelativeFieldId }[] = [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      const field = yield* lowerFieldId(schema, step);
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
      lowered.push({ field: field.id });
    }
    return {
      _tag: "ref" as const,
      root: { _tag: "resource" as const },
      steps: lowered,
    };
  });

const lowerOperand = (
  schema: AnySchema,
  input: unknown,
  role: "eq" | "contains-collection" | "contains-value" | "term",
): Result.Result<RelativeValueTerm, InvalidIR> =>
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
    const operand = input as BoxedOperand;
    switch (operand._tag) {
      case "me":
        return { _tag: "me" as const };
      case "subject":
        return { _tag: "subject" as const };
      case "claim":
        if (operand.key.length === 0) {
          return yield* invalid("blank claim key");
        }
        return { _tag: "claim" as const, key: operand.key };
      case "lit":
        if (typeof operand.value === "number" && !Number.isFinite(operand.value)) {
          return yield* invalid("literal is not a JSON scalar");
        }
        return { _tag: "lit" as const, value: operand.value };
      case "path":
        return yield* lowerPathSteps(schema, operand.steps, role);
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

const lowerExpr = (schema: AnySchema, input: unknown): Result.Result<LoweredExpr, InvalidIR> =>
  Result.gen(function* () {
    if (typeof input !== "object" || input === null) {
      return yield* invalid("unsupported expression");
    }
    const tag = (input as { readonly _tag?: unknown })._tag;
    if (typeof tag !== "string" || !SUPPORTED_EXPR_TAGS.has(tag)) {
      return yield* invalid(
        `unsupported expression tag '${typeof tag === "string" ? tag : "unknown"}'`,
      );
    }
    const expr = input as AuthExpr;
    switch (expr._tag) {
      case "const":
        return { expr: { _tag: "const" as const, value: expr.value }, classes: [], claims: [] };
      case "hasClass":
        if (expr.class.length === 0) {
          return yield* invalid("blank class name");
        }
        return {
          expr: { _tag: "hasClass" as const, class: expr.class },
          classes: [expr.class],
          claims: [],
        };
      case "and":
      case "or": {
        if (expr.exprs.length === 0) {
          return yield* invalid(
            expr._tag === "and" ? "empty all() is invalid" : "empty any() is invalid",
          );
        }
        const children: RelativeAuthorizationExpr[] = [];
        const classes: string[] = [];
        const claims: string[] = [];
        for (const child of expr.exprs) {
          const lowered = yield* lowerExpr(schema, child);
          children.push(lowered.expr);
          mergeUnique(classes, lowered.classes);
          mergeUnique(claims, lowered.claims);
        }
        return {
          expr:
            expr._tag === "and"
              ? { _tag: "and" as const, exprs: children }
              : { _tag: "or" as const, exprs: children },
          classes,
          claims,
        };
      }
      case "not": {
        const child = yield* lowerExpr(schema, expr.expr);
        return {
          expr: { _tag: "not" as const, expr: child.expr },
          classes: child.classes,
          claims: child.claims,
        };
      }
      case "eq": {
        const left = yield* lowerOperand(schema, expr.left, "eq");
        const right = yield* lowerOperand(schema, expr.right, "eq");
        return {
          expr: { _tag: "eq" as const, left, right },
          classes: [],
          claims: claimKeysOf([left, right]),
        };
      }
      case "in": {
        const collection = yield* lowerOperand(schema, expr.collection, "contains-collection");
        const value = yield* lowerOperand(schema, expr.value, "contains-value");
        return {
          expr: { _tag: "in" as const, value, collection },
          classes: [],
          claims: claimKeysOf([value, collection]),
        };
      }
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

    const rules: RelativeAuthorizationRule[] = [];
    const bodies = new Set<string>();
    const buckets = new Map<string, DecisionBucket>();

    for (let i = 0; i < input.rules.length; i++) {
      const authored = yield* requireReadRule(input.rules[i]);
      const focus = yield* lowerFocus(input.schema, authored.target);
      const lowered = yield* lowerExpr(input.schema, authored.expr);
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
