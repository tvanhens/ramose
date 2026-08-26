/**
 * Compile authoring bindings to {@link AuthorizationIR}.
 * Callbacks run once here and are discarded. Validation is fail-closed.
 */

import type * as SchemaNS from "effect/Schema";
import type { AnyEntity } from "../db/Entity.ts";
import type { AnyOperation } from "../db/Operation.ts";
import type { AnySchema } from "../db/Schema.ts";
import { PolicyError } from "../db/SchemaErrors.ts";
import { traitsOf, walkTraits, type ComposerLike } from "../db/compose.ts";
import type { AnyTrait } from "../db/Trait.ts";
import {
  MAX_TRAVERSAL_DEPTH,
  REGISTERED_CLAIM_KEYS,
  type AuthorizationIR,
  type FieldId,
  type IrDecision,
  type IrExpr,
  type IrOperand,
  type IrPath,
  type IrRule,
  type OperationId,
  type OwnerId,
} from "../internal/authorization/ir.ts";
import { ruleIdOf } from "../internal/authorization/canonical.ts";
import { parseAuthorizationIR } from "../internal/authorization/parse.ts";
import {
  isTargetless,
  ownerOfOperation,
  type Allowable,
  type AuthBinding,
  type AuthOperation,
  type AuthRule,
} from "./authoring.ts";
import {
  claimsProxy,
  inputProxy,
  isAuthExpr,
  mePath,
  snapshotOf,
  withBindScope,
  type AnyFocus,
  type AuthExpr,
} from "./expr.ts";

const fail = (message: string, ident?: string): never => {
  throw new PolicyError({ message: `ramose/authorization: ${message}`, ident });
};

export interface AuthorizationHead<
  C extends AnySchema = AnySchema,
  CL extends readonly string[] = readonly string[],
> {
  readonly schema: C;
  readonly principal: { readonly ident: string };
  readonly classes: CL;
  readonly claims?: SchemaNS.Struct<SchemaNS.Struct.Fields>;
  /** Registered operations recorded in IR identities. Missing arms deny. */
  readonly operations?: readonly AnyOperation[];
}

type CatalogField = FieldId & { readonly focus: AnyFocus };

interface Catalog {
  readonly entities: ReadonlyMap<string, AnyEntity>;
  readonly traits: ReadonlyMap<string, AnyTrait>;
  readonly fields: ReadonlyMap<string, CatalogField>;
  readonly composed: ReadonlyMap<string, ReadonlySet<string>>;
  readonly principal: { readonly ident: string; readonly entity: AnyEntity };
  readonly classes: ReadonlySet<string>;
  readonly claimKeys: ReadonlySet<string>;
}

const isEntity = (value: unknown): value is AnyEntity =>
  typeof value === "object" &&
  value !== null &&
  (value as { readonly _tag?: unknown })._tag === "Entity";

const isTrait = (value: unknown): value is AnyTrait =>
  typeof value === "object" &&
  value !== null &&
  (value as { readonly _tag?: unknown })._tag === "Trait";

const ownerIdOf = (focus: AnyFocus): OwnerId => ({
  kind: focus._tag === "Trait" ? "trait" : "entity",
  ns: focus.ns,
});

const structKeys = (schema: unknown): readonly string[] | undefined => {
  if (schema && typeof schema === "object" && "fields" in schema) {
    const fields = (schema as { readonly fields?: unknown }).fields;
    if (fields && typeof fields === "object") return Object.keys(fields);
  }
  return undefined;
};

const buildCatalog = (head: AuthorizationHead): Catalog => {
  if (head == null || typeof head !== "object" || head.schema?._tag !== "Schema") {
    fail("compile() takes a head { schema, principal, classes }");
  }
  const entities = new Map<string, AnyEntity>();
  for (const [key, entity] of Object.entries(head.schema.entities)) {
    if (!isEntity(entity)) fail(`schema.${key} is not an Entity`);
    entities.set(entity.ns, entity);
  }

  const traits = new Map<string, AnyTrait>();
  const composed = new Map<string, Set<string>>();
  for (const entity of entities.values()) {
    const reachable = walkTraits(traitsOf(entity as unknown as ComposerLike)).all;
    const set = new Set<string>();
    for (const trait of reachable) {
      if (isTrait(trait)) traits.set(trait.ns, trait);
      set.add(trait.ns);
    }
    composed.set(entity.ns, set);
  }
  for (const trait of traits.values()) {
    const reachable = walkTraits(traitsOf(trait as unknown as ComposerLike)).all;
    const set = new Set<string>([trait.ns]);
    for (const inner of reachable) set.add(inner.ns);
    composed.set(trait.ns, set);
  }

  const fields = new Map<string, CatalogField>();
  const indexFocus = (focus: AnyFocus, owner: OwnerId): void => {
    for (const [name, field] of Object.entries(focus.fields)) {
      const ident = typeof field?.ident === "string" ? field.ident : undefined;
      if (ident === undefined) continue;
      const existing = fields.get(ident);
      const id: CatalogField = {
        kind: "field",
        ident,
        owner,
        name,
        cardinality: field.cardinality === "many" ? "many" : "one",
        valueType: typeof field.valueType === "string" ? field.valueType : "unknown",
        focus,
      };
      if (existing !== undefined && existing.ident === ident) continue;
      fields.set(ident, id);
    }
  };
  for (const trait of traits.values()) indexFocus(trait, { kind: "trait", ns: trait.ns });
  for (const entity of entities.values()) indexFocus(entity, { kind: "entity", ns: entity.ns });

  const principalIdent = head.principal?.ident;
  if (typeof principalIdent !== "string" || !principalIdent.includes("/")) {
    return fail("head.principal must be a stamped field (User.sub)");
  }
  const principalField = fields.get(principalIdent);
  if (principalField === undefined || principalField.owner.kind !== "entity") {
    return fail(`principal ${principalIdent} is not an entity field in the schema`, principalIdent);
  }
  const principalEntity = entities.get(principalField.owner.ns);
  if (principalEntity === undefined) {
    return fail(`principal ${principalIdent} is not in the schema`, principalIdent);
  }

  const classes = head.classes;
  if (!Array.isArray(classes) || classes.length === 0) fail("classes must not be empty");
  if (new Set(classes).size !== classes.length) fail("duplicate class");
  for (const name of classes) {
    if (typeof name !== "string" || name.length === 0) fail("class names must be non-empty strings");
  }

  const declaredClaims = structKeys(head.claims) ?? [];
  const claimKeys = new Set<string>([...REGISTERED_CLAIM_KEYS, ...declaredClaims]);

  return {
    entities,
    traits,
    fields,
    composed,
    principal: { ident: principalIdent, entity: principalEntity },
    classes: new Set(classes),
    claimKeys,
  };
};

interface Analysis {
  readonly usesResource: boolean;
  readonly usesInput: boolean;
  readonly maxDepth: number;
  readonly exists: readonly string[];
  readonly claimKeys: readonly string[];
  readonly inputKeys: readonly string[];
  readonly bindDepth: Readonly<Record<string, number>>;
}

const pathDepth = (path: IrPath): number =>
  path.steps.filter((step) => step.ident !== undefined && (step.valueType === "ref" || step.ident === ":db/id")).length;

const pathRootKind = (root: string): "resource" | "me" | "claims" | "input" | "bind" => {
  if (root === "resource" || root === "me" || root === "claims" || root === "input") return root;
  return "bind";
};

const analyzePath = (path: IrPath, analysis: MutableAnalysis): void => {
  const kind = pathRootKind(path.root);
  if (kind === "resource") analysis.usesResource = true;
  if (kind === "input") {
    analysis.usesInput = true;
    for (const step of path.steps) {
      if (step.key !== undefined) analysis.inputKeys.add(step.key);
    }
  }
  if (kind === "claims") {
    for (const step of path.steps) {
      if (step.key !== undefined) analysis.claimKeys.add(step.key);
    }
  }
  const extra = pathDepth(path);
  const base = kind === "bind" ? (analysis.bindDepth[path.root] ?? 0) : 0;
  analysis.maxDepth = Math.max(analysis.maxDepth, base + extra);
};

interface MutableAnalysis {
  usesResource: boolean;
  usesInput: boolean;
  maxDepth: number;
  readonly exists: Set<string>;
  readonly claimKeys: Set<string>;
  readonly inputKeys: Set<string>;
  readonly bindDepth: Record<string, number>;
  readonly existsStack: string[];
}

const analyzeOperand = (operand: IrOperand, analysis: MutableAnalysis): void => {
  if (operand.kind === "path") analyzePath(operand.path, analysis);
};

const analyzeExpr = (expr: IrExpr, analysis: MutableAnalysis): void => {
  switch (expr.kind) {
    case "const":
    case "hasClass":
      return;
    case "eq":
      analyzeOperand(expr.left, analysis);
      analyzeOperand(expr.right, analysis);
      return;
    case "has":
      analyzePath(expr.path, analysis);
      if (expr.value !== undefined) analyzeOperand(expr.value, analysis);
      return;
    case "some": {
      analyzePath(expr.path, analysis);
      const hop = pathDepth(expr.path);
      const parent = pathRootKind(expr.path.root) === "bind" ? (analysis.bindDepth[expr.path.root] ?? 0) : 0;
      analysis.bindDepth[expr.bind] = parent + hop;
      analyzeExpr(expr.body, analysis);
      return;
    }
    case "overlaps":
      analyzePath(expr.left, analysis);
      analyzePath(expr.right, analysis);
      return;
    case "exists":
      if (analysis.existsStack.includes(expr.entity)) {
        fail(`unsupported recursion: exists(${expr.entity}) contains exists(${expr.entity})`);
      }
      analysis.exists.add(expr.entity);
      analysis.existsStack.push(expr.entity);
      analysis.bindDepth[expr.bind] = 0;
      analyzeExpr(expr.body, analysis);
      analysis.existsStack.pop();
      return;
    case "and":
    case "or":
      for (const child of expr.exprs) analyzeExpr(child, analysis);
      return;
    case "not":
      analyzeExpr(expr.expr, analysis);
      return;
  }
};

const analyze = (expr: IrExpr): Analysis => {
  const mutable: MutableAnalysis = {
    usesResource: false,
    usesInput: false,
    maxDepth: 0,
    exists: new Set(),
    claimKeys: new Set(),
    inputKeys: new Set(),
    bindDepth: {},
    existsStack: [],
  };
  analyzeExpr(expr, mutable);
  return {
    usesResource: mutable.usesResource,
    usesInput: mutable.usesInput,
    maxDepth: mutable.maxDepth,
    exists: [...mutable.exists],
    claimKeys: [...mutable.claimKeys],
    inputKeys: [...mutable.inputKeys],
    bindDepth: mutable.bindDepth,
  };
};

const lastStep = (path: IrPath): IrPath["steps"][number] | undefined => path.steps[path.steps.length - 1];

const validateExprShape = (expr: IrExpr, where: string): void => {
  switch (expr.kind) {
    case "some": {
      const step = lastStep(expr.path);
      if (step !== undefined && step.cardinality !== "many") {
        fail(`${where}: some() requires a card-many path`);
      }
      validateExprShape(expr.body, where);
      return;
    }
    case "overlaps": {
      const left = lastStep(expr.left);
      const right = lastStep(expr.right);
      if (left?.cardinality !== "many" || right?.cardinality !== "many") {
        fail(`${where}: overlaps() requires two card-many paths`);
      }
      return;
    }
    case "eq": {
      const card = (operand: IrOperand): string | undefined => {
        if (operand.kind !== "path") return undefined;
        return lastStep(operand.path)?.cardinality;
      };
      if (card(expr.left) === "many" || card(expr.right) === "many") {
        fail(`${where}: eq() does not compare card-many paths — use has(), some(), or overlaps()`);
      }
      return;
    }
    case "and":
    case "or":
      for (const child of expr.exprs) validateExprShape(child, where);
      return;
    case "not":
      validateExprShape(expr.expr, where);
      return;
    case "has":
    case "exists":
    case "const":
    case "hasClass":
      if (expr.kind === "exists") validateExprShape(expr.body, where);
      return;
  }
};

const lowerRule = (
  catalog: Catalog,
  allowable: Allowable,
  where: string,
  targetFocus: AnyFocus | undefined,
): { readonly rule: IrRule; readonly analysis: Analysis } => {
  const lowered = withBindScope(() => {
    if (isAuthExpr(allowable)) return allowable;
    if (allowable._tag !== "AuthRule") fail(`${where}: expected rule(...) or an expression`);
    const focus = allowable.focus;
    const produced = allowable.body({
      me: mePath(catalog.principal.entity),
      resource: snapshotOf(focus, "resource") as never,
      claims: claimsProxy() as unknown as { readonly [key: string]: import("./expr.ts").AuthPath },
      input: inputProxy() as unknown as { readonly [key: string]: import("./expr.ts").AuthPath },
    });
    if (produced !== undefined && typeof (produced as { then?: unknown }).then === "function") {
      fail(`${where}: illegal effect — rule callbacks must be synchronous`);
    }
    if (!isAuthExpr(produced)) fail(`${where}: rule callback must return an expression`);
    return produced;
  });

  const expr = (lowered as AuthExpr).expr;
  validateExprShape(expr, where);
  const analysis = analyze(expr);
  if (analysis.maxDepth > MAX_TRAVERSAL_DEPTH) {
    fail(`${where}: traversal depth ${analysis.maxDepth} exceeds ${MAX_TRAVERSAL_DEPTH}`);
  }
  for (const key of analysis.claimKeys) {
    if (!catalog.claimKeys.has(key)) fail(`${where}: claim ${JSON.stringify(key)} is not declared`);
  }
  for (const ns of analysis.exists) {
    if (!catalog.entities.has(ns)) fail(`${where}: exists(${ns}) is not in the schema`, ns);
  }

  const focus: AnyFocus = allowable._tag === "AuthRule" ? allowable.focus : (targetFocus ?? catalog.principal.entity);
  if (allowable._tag === "AuthRule") {
    if (targetFocus !== undefined) assertReusable(catalog, allowable, targetFocus, where);
  }

  return {
    rule: {
      id: ruleIdOf(ownerIdOf(focus), expr),
      focus: ownerIdOf(focus),
      expr,
      usesResource: analysis.usesResource,
      usesInput: analysis.usesInput,
    },
    analysis,
  };
};

const assertReusable = (
  catalog: Catalog,
  rule: AuthRule,
  target: AnyFocus,
  where: string,
): void => {
  if (rule.focus === target) return;
  if (rule.focus.ns === target.ns && rule.focus._tag === target._tag) return;
  if (rule.focus._tag === "Trait") {
    const composed = catalog.composed.get(target.ns);
    if (composed?.has(rule.focus.ns)) return;
    fail(
      `${where}: trait rule ${rule.focus.ns} is not composed by ${target._tag} ${target.ns}`,
      rule.focus.ns,
    );
  }
  fail(`${where}: rule focus ${rule.focus.ns} does not match ${target.ns}`, rule.focus.ns);
};

const decisionOf = (
  catalog: Catalog,
  binding: AuthBinding,
  where: string,
  targetFocus: AnyFocus | undefined,
  intern: Map<string, IrRule>,
  inputKeys: ReadonlySet<string> | undefined,
  targetless: boolean,
): IrDecision => {
  const lowerArms = (arms: readonly Allowable[], side: string): string[] => {
    const ids: string[] = [];
    for (const [i, arm] of arms.entries()) {
      const at = `${where}.${side}[${i}]`;
      const { rule, analysis } = lowerRule(catalog, arm, at, targetFocus);
      if (targetless && analysis.usesResource) {
        fail(`${at}: resource-dependent rule on a targetless operation`);
      }
      if (analysis.usesInput) {
        if (inputKeys === undefined) return fail(`${at}: input is only valid on run() rules`);
        for (const key of analysis.inputKeys) {
          if (!inputKeys.has(key)) return fail(`${at}: input.${key} is not on the operation`);
        }
      }
      intern.set(rule.id, rule);
      ids.push(rule.id);
    }
    return ids;
  };
  return {
    allow: lowerArms(binding.allowArms, "allow"),
    deny: lowerArms(binding.denyArms, "deny"),
  };
};

const isBinding = (value: unknown): value is AuthBinding =>
  typeof value === "object" &&
  value !== null &&
  (value as { readonly _tag?: unknown })._tag === "AuthBinding";

const focusOfBinding = (catalog: Catalog, binding: AuthBinding): AnyFocus | undefined => {
  if (binding.kind === "row") return binding.entity;
  if (binding.kind === "trait") return binding.trait;
  if (binding.kind === "field") {
    const field = catalog.fields.get(binding.field!.ident);
    return field?.focus;
  }
  if (binding.kind === "operation") return ownerOfOperation(binding.operation!);
  return undefined;
};

const putDecision = (
  map: Record<string, IrDecision>,
  key: string,
  decision: IrDecision,
  where: string,
): void => {
  if (map[key] !== undefined) fail(`${where}: ambiguous — ${key} already has a binding`);
  map[key] = decision;
};

const operationIdentity = (op: AuthOperation): OperationId => {
  const owner = ownerOfOperation(op);
  return {
    kind: "operation",
    name: op.name,
    ...(owner !== undefined ? { owner: ownerIdOf(owner) } : {}),
    targetless: isTargetless(op),
  };
};

/**
 * Compile bindings to a serializable IR document. Round-trips through the
 * fail-closed parser so incomplete output cannot escape.
 */
export const compileAuthorization = (
  head: AuthorizationHead,
  bindings: readonly AuthBinding[],
): AuthorizationIR => {
  const catalog = buildCatalog(head);
  if (!Array.isArray(bindings)) fail("compile() takes an array of read()/run() bindings");
  const intern = new Map<string, IrRule>();
  const rows: Record<string, IrDecision> = {};
  const traits: Record<string, IrDecision> = {};
  const fields: Record<string, IrDecision> = {};
  const operations: Record<string, IrDecision> = {};
  const opIds = new Map<string, OperationId>();

  for (const op of head.operations ?? []) {
    if (op?._tag !== "Operation") fail("head.operations entries must be Operation values");
    opIds.set(op.name, operationIdentity(op as AuthOperation));
  }

  for (const [index, raw] of bindings.entries()) {
    if (!isBinding(raw)) fail(`bindings[${index}]: expected read(...).allow(...) or run(...).allow(...)`);
    if (raw.allowArms.length === 0 && raw.denyArms.length === 0) {
      fail(`bindings[${index}]: missing allow(...) or deny(...)`);
    }
    const where = `bindings[${index}]`;
    const target = focusOfBinding(catalog, raw);

    if (raw.kind === "row") {
      const entity = raw.entity!;
      if (!catalog.entities.has(entity.ns)) fail(`${where}: entity ${entity.ns} is not in the schema`, entity.ns);
      putDecision(rows, entity.ns, decisionOf(catalog, raw, where, entity, intern, undefined, false), `${where} read(${entity.ns})`);
      continue;
    }
    if (raw.kind === "trait") {
      const trait = raw.trait!;
      if (!catalog.traits.has(trait.ns)) {
        fail(`${where}: trait ${trait.ns} is not composed by the schema`, trait.ns);
      }
      putDecision(traits, trait.ns, decisionOf(catalog, raw, where, trait, intern, undefined, false), `${where} read(${trait.ns})`);
      continue;
    }
    if (raw.kind === "field") {
      const ident = raw.field!.ident;
      const field = catalog.fields.get(ident);
      if (field === undefined) return fail(`${where}: ${ident} is not in the schema`, ident);
      putDecision(fields, ident, decisionOf(catalog, raw, where, field.focus, intern, undefined, false), `${where} read(${ident})`);
      continue;
    }

    const op = raw.operation!;
    if (typeof op.name !== "string" || op.name.length === 0) fail(`${where}: operation has no name`);
    const owner = ownerOfOperation(op);
    if (owner?._tag === "Trait" && !catalog.traits.has(owner.ns)) {
      fail(`${where}: trait ${owner.ns} is not reachable in the catalog`, owner.ns);
    }
    if (owner?._tag === "Entity" && !catalog.entities.has(owner.ns)) {
      fail(`${where}: entity ${owner.ns} is not in the schema`, owner.ns);
    }
    const inputKeys = new Set(structKeys(op.input) ?? []);
    const targetless = isTargetless(op);
    putDecision(
      operations,
      op.name,
      decisionOf(catalog, raw, where, owner, intern, inputKeys, targetless),
      `${where} run(${op.name})`,
    );
    opIds.set(op.name, operationIdentity(op));
  }

  const ir: AuthorizationIR = {
    version: 1,
    principal: { ident: catalog.principal.ident, entity: catalog.principal.entity.ns },
    classes: [...catalog.classes],
    claims: [...catalog.claimKeys].sort(),
    identities: {
      entities: [...catalog.entities.keys()].sort().map((ns) => ({ kind: "entity" as const, ns })),
      traits: [...catalog.traits.keys()].sort().map((ns) => ({ kind: "trait" as const, ns })),
      fields: [...catalog.fields.values()]
        .map(({ focus: _focus, ...field }) => field)
        .sort((a, b) => a.ident.localeCompare(b.ident)),
      operations: [...opIds.values()].sort((a, b) => a.name.localeCompare(b.name)),
    },
    rules: [...intern.values()].sort((a, b) => a.id.localeCompare(b.id)),
    rows,
    traits,
    fields,
    operations,
  };

  return parseAuthorizationIR(ir);
};
