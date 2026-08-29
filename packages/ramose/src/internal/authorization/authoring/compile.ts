/**
 * Compile the read-authorization language into {@link PolicyTemplateIR} (#406).
 *
 * Pure kernel (`Result.gen`) lowers stamped paths, merges decisions, and
 * decodes through Effect Schema. Semantic compatibility — trait composition,
 * self-ref / ref-target, equality, membership, path reachability — is owned
 * by authoritative installation. The Effect shell restamps rule identities
 * with {@link hashRelativeRule}.
 */

import type { AnySchema } from "../../../db/Schema.ts";
import { schemaTraits } from "../../../db/Schema.ts";
import {
  isOwnedOperation,
  OwnedOperations,
  type AnyOwnedOperation,
} from "../../../db/Operation.ts";
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
import { RuleId, type OwnerRef, type RelativeEntityId, type RelativeFieldId, type RelativeOperationId, type RelativeTraitId } from "../identities.ts";
import type {
  PolicyTemplateIR,
  RelativeAuthorizationRule,
  RelativeRuleFocus,
} from "../ir.ts";
import { POLICY_TEMPLATE_IR_VERSION, RelativeAuthorizationRule as RelativeAuthorizationRuleSchema } from "../ir.ts";
import type { JsonValue } from "../json.ts";
import type { PrincipalResolutionConfig } from "../principal.ts";
import { AUTHORIZATION_LANGUAGE_VERSION } from "../version.ts";
import { clonePlain, remapDecision } from "../plain.ts";
import type {
  RelativeAuthorizationExpr,
  RelativeValueTerm,
} from "../expr.ts";
import {
  isEntityTarget,
  INVOKE_RULE_TAG,
  isJsonScalar,
  isPathCarrier,
  isTraitTarget,
  parseIdent,
  READ_RULE_TAG,
  stepFromCarrier,
  type AuthPathStep,
  type CompileReadAuthorizationInput,
  type AuthorizationRule as AuthoredAuthorizationRule,
  type ReadTarget,
} from "./types.ts";

const SUPPORTED_EXPR_TAGS = new Set(["const", "hasClass", "and", "or", "not", "eq", "in"]);
const SUPPORTED_OPERAND_TAGS = new Set(["me", "subject", "claim", "lit", "path"]);

const invalid = (message: string): Result.Result<never, InvalidIR> =>
  Result.fail(new InvalidIR({ message }));

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
): { readonly ident: string } | undefined => {
  const fields =
    owner.kind === "entity"
      ? schema.entities[owner.name]?.fields
      : schemaTraits(schema).get(owner.name)?.fields;
  const field = fields?.[localName] as { readonly ident?: unknown } | undefined;
  if (field === undefined || typeof field.ident !== "string") return undefined;
  return { ident: field.ident };
};

type NodeBudget = { nodes: number };

const takeNodes = (budget: NodeBudget, n: number): Result.Result<void, InvalidIR> => {
  budget.nodes += n;
  if (budget.nodes > MAX_JSON_NODES) {
    return invalid(`expression node budget ${budget.nodes} exceeds ${MAX_JSON_NODES}`);
  }
  return Result.succeed(undefined);
};

const lowerFieldId = (
  schema: AnySchema,
  step: AuthPathStep,
): Result.Result<
  {
    readonly id: { readonly _tag: "RelativeFieldId"; readonly owner: OwnerRef; readonly localName: string };
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
    return { id: { _tag: "RelativeFieldId" as const, owner, localName } };
  });

const lowerPathSteps = (
  schema: AnySchema,
  steps: readonly AuthPathStep[],
  budget: NodeBudget,
): Result.Result<RelativeValueTerm, InvalidIR> =>
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
    for (const step of steps) {
      const field = yield* lowerFieldId(schema, step);
      lowered.push({ field: field.id });
    }
    return {
      _tag: "ref" as const,
      root: { _tag: "resource" as const },
      steps: lowered,
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
    checked.push({
      ident,
      localName,
      reverse: (step as { readonly reverse?: unknown }).reverse === true,
    });
  }
  return Result.succeed(checked);
};

const lowerOperand = (
  schema: AnySchema,
  input: unknown,
  budget: NodeBudget,
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
    yield* takeNodes(budget, 1);
    switch (tag) {
      case "me":
        return { _tag: "me" as const };
      case "subject":
        return { _tag: "subject" as const };
      case "claim": {
        const key = (input as { readonly key?: unknown }).key;
        if (typeof key !== "string") {
          return yield* invalid("malformed claim");
        }
        if (key.length === 0) {
          return yield* invalid("blank claim key");
        }
        return { _tag: "claim" as const, key };
      }
      case "lit": {
        const value = (input as { readonly value?: unknown }).value;
        if (!isJsonScalar(value)) {
          return yield* invalid("literal is not a JSON scalar");
        }
        return { _tag: "lit" as const, value };
      }
      case "path":
        return yield* lowerPathSteps(schema, yield* readPathSteps(input), budget);
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
  schema: AnySchema,
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
          const lowered = yield* lowerExpr(schema, child, budget, depth + 1);
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
        const child = yield* lowerExpr(schema, childExpr, budget, depth + 1);
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
        const left = yield* lowerOperand(schema, leftInput, budget);
        const right = yield* lowerOperand(schema, rightInput, budget);
        return {
          expr: { _tag: "eq" as const, left, right },
          classes: [],
          claims: claimKeysOf([left, right]),
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
        const collection = yield* lowerOperand(schema, collectionInput, budget);
        const value = yield* lowerOperand(schema, valueInput, budget);
        return {
          expr: { _tag: "in" as const, value, collection },
          classes: [],
          claims: claimKeysOf([value, collection]),
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
  target: ReadTarget | AnyOwnedOperation,
): Result.Result<RelativeRuleFocus, InvalidIR> =>
  Result.gen(function* () {
    if (isOwnedOperation(target)) {
      const owner =
        target.owner._tag === "Entity"
          ? schema.entities[target.owner.ns]
          : schemaTraits(schema).get(target.owner.ns);
      if (
        owner === undefined ||
        owner !== target.owner ||
        owner[OwnedOperations]?.[target.localName] !== target
      ) {
        return yield* invalid(
          `operation '${target.owner.ns}.${target.localName}' is not in this catalog`,
        );
      }
      return {
        _tag: "operation" as const,
        operation: {
          _tag: "RelativeOperationId" as const,
          owner: {
            kind: target.owner._tag === "Entity" ? "entity" as const : "trait" as const,
            name: target.owner.ns,
          },
          localName: target.localName,
          target: target.self ? "required" as const : "none" as const,
        },
      };
    }
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
    return yield* invalid("rule target must be a reachable Entity, Trait, field, or owned operation");
  });

const focusTargetKey = (focus: RelativeRuleFocus): string => {
  switch (focus._tag) {
    case "entity":
      return `entity\0${focus.entity.name}`;
    case "trait":
      return `trait\0${focus.trait.name}`;
    case "field":
      return `field\0${focus.field.owner.kind}\0${focus.field.owner.name}\0${focus.field.localName}`;
    case "operation":
      return `operation\0${focus.operation.owner.kind}\0${focus.operation.owner.name}\0${focus.operation.localName}\0${focus.operation.target}`;
  }
};

const focusTarget = (
  focus: RelativeRuleFocus,
): RelativeEntityId | RelativeTraitId | RelativeFieldId | RelativeOperationId => {
  switch (focus._tag) {
    case "entity":
      return focus.entity;
    case "trait":
      return focus.trait;
    case "field":
      return focus.field;
    case "operation":
      return focus.operation;
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
    return { subjectClaim, entity: field.id };
  });

const requireAuthorizationRule = (
  rule: unknown,
): Result.Result<AuthoredAuthorizationRule, InvalidIR> => {
  if (
    typeof rule !== "object" ||
    rule === null ||
    (rule as { readonly _tag?: unknown })._tag !== READ_RULE_TAG &&
    (rule as { readonly _tag?: unknown })._tag !== INVOKE_RULE_TAG
  ) {
    return invalid("rules must be produced by read() or invoke()");
  }
  return Result.succeed(rule as AuthoredAuthorizationRule);
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
    const documentBudget: NodeBudget = { nodes: 0 };

    for (let i = 0; i < input.rules.length; i++) {
      const authored = yield* requireAuthorizationRule(input.rules[i]);
      const focus = yield* lowerFocus(input.schema, authored.target);
      const lowered = yield* lowerExpr(input.schema, authored.expr, documentBudget);
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
      if (
        authored._tag === INVOKE_RULE_TAG &&
        (flags.usesResource || flags.usesMe || flags.traversalDepth !== 0)
      ) {
        return yield* invalid(
          "operation grants may use only principal classes, claims, and subject identity",
        );
      }
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
    const operations: Array<{
      readonly target: RelativeOperationId;
      readonly decision: { readonly allow: readonly RuleId[]; readonly deny: readonly RuleId[] };
    }> = [];
    for (const bucket of buckets.values()) {
      const decision = { allow: bucket.allow, deny: bucket.deny };
      if (bucket.focusKey.startsWith("entity\0")) {
        entities.push({ target: bucket.target as RelativeEntityId, decision });
      } else if (bucket.focusKey.startsWith("trait\0")) {
        traits.push({ target: bucket.target as RelativeTraitId, decision });
      } else if (bucket.focusKey.startsWith("field\0")) {
        fields.push({ target: bucket.target as RelativeFieldId, decision });
      } else {
        operations.push({ target: bucket.target as RelativeOperationId, decision });
      }
    }
    const decisions = { entities, traits, fields, operations };

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
          decision: remapDecision(entry.decision, idMap),
        })),
        traits: template.decisions.traits.map((entry) => ({
          ...entry,
          decision: remapDecision(entry.decision, idMap),
        })),
        fields: template.decisions.fields.map((entry) => ({
          ...entry,
          decision: remapDecision(entry.decision, idMap),
        })),
        operations: template.decisions.operations.map((entry) => ({
          ...entry,
          decision: remapDecision(entry.decision, idMap),
        })),
      },
    };
    return yield* Effect.fromResult(
      decodePolicyTemplateResult(clonePlain(encodePolicyTemplate(restamped))),
    );
  },
);
