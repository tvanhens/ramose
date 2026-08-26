/**
 * Compile authoring bindings to a catalog-relative template, then install
 * a sealed {@link InstalledAuthorizationIR}. Callbacks run once and are
 * discarded. Validation is fail-closed.
 */

import * as Effect from "effect/Effect";
import type * as SchemaNS from "effect/Schema";
import type { AnyEntity } from "../db/Entity.ts";
import type { AnyOperation } from "../db/Operation.ts";
import type { AnySchema } from "../db/Schema.ts";
import { PolicyError } from "../db/SchemaErrors.ts";
import { traitsOf, walkTraits, type ComposerLike } from "../db/compose.ts";
import type { AnyTrait } from "../db/Trait.ts";
import { analyze, exceedsTraversal, exprShapeError } from "../internal/authorization/analyze.ts";
import { canonicalJson, ruleIdOf } from "../internal/authorization/canonical.ts";
import { CatalogMismatch, InvalidIR } from "../internal/authorization/errors.ts";
import { catalogFromTemplate, installAgainstCatalog } from "../internal/authorization/install.ts";
import type {
  FieldId,
  InstalledAuthorizationIR,
  IrDecision,
  IrRule,
  OperationId,
  OwnerId,
  PolicyTemplateIR,
  PrincipalSpec,
} from "../internal/authorization/ir.ts";
import { REGISTERED_CLAIM_KEYS } from "../internal/authorization/ir.ts";
import { recomputeRuleMetadata } from "../internal/authorization/validate.ts";
import {
  isBoundOperation,
  localNameOfOperation,
  ownerOfOperation,
  targetOfOperation,
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
  readonly principal?: { readonly ident: string };
  readonly classes?: CL;
  readonly claims?: SchemaNS.Struct<SchemaNS.Struct.Fields>;
  /** Registered operations recorded when bound via `withOperations`. */
  readonly operations?: readonly AnyOperation[];
}

type CatalogField = FieldId & { readonly focus: AnyFocus };

interface Catalog {
  readonly entities: ReadonlyMap<string, AnyEntity>;
  readonly traits: ReadonlyMap<string, AnyTrait>;
  readonly fields: ReadonlyMap<string, CatalogField>;
  readonly composed: ReadonlyMap<string, ReadonlySet<string>>;
  readonly principal?: { readonly ident: string; readonly entity: AnyEntity };
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
    fail("compile() takes a head { schema, classes? }");
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

  let principal: Catalog["principal"];
  const principalIdent = head.principal?.ident;
  if (principalIdent !== undefined) {
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
    principal = { ident: principalIdent, entity: principalEntity };
  }

  const classes = head.classes ?? [];
  if (!Array.isArray(classes)) fail("classes must be an array");
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
    principal,
    classes: new Set(classes),
    claimKeys,
  };
};

const internRule = (intern: Map<string, IrRule>, rule: IrRule, where: string): void => {
  const sealed = recomputeRuleMetadata(rule);
  const previous = intern.get(sealed.id);
  if (previous !== undefined && canonicalJson(previous.expr) !== canonicalJson(sealed.expr)) {
    fail(`${where}: rule id ${sealed.id} maps to two different bodies`);
  }
  intern.set(sealed.id, sealed);
};

const lowerRule = (
  catalog: Catalog,
  allowable: Allowable,
  where: string,
  targetFocus: AnyFocus | undefined,
): { readonly rule: IrRule } => {
  const lowered = withBindScope(() => {
    if (isAuthExpr(allowable)) return allowable;
    if (allowable._tag !== "AuthRule") fail(`${where}: expected rule(...) or an expression`);
    const focus = allowable.focus;
    const produced = allowable.body({
      me: mePath(catalog.principal?.entity),
      resource: snapshotOf(focus, "resource") as never,
      claims: claimsProxy() as never,
      input: inputProxy() as never,
    });
    if (produced !== undefined && typeof (produced as { then?: unknown }).then === "function") {
      fail(`${where}: illegal effect — rule callbacks must be synchronous`);
    }
    if (!isAuthExpr(produced)) fail(`${where}: rule callback must return an expression`);
    return produced;
  });

  const expr = (lowered as AuthExpr).expr;
  const shape = exprShapeError(expr, where);
  if (shape !== undefined) fail(shape);
  const analysis = analyze(expr);
  if (exceedsTraversal(analysis)) {
    fail(`${where}: traversal depth ${analysis.maxDepth} exceeds the limit`);
  }
  for (const key of analysis.claimKeys) {
    if (!catalog.claimKeys.has(key)) fail(`${where}: claim ${JSON.stringify(key)} is not declared`);
  }
  for (const name of analysis.classNames) {
    if (!catalog.classes.has(name)) fail(`${where}: class ${JSON.stringify(name)} is not declared`);
  }
  for (const ns of analysis.exists) {
    if (!catalog.entities.has(ns)) fail(`${where}: exists(${ns}) is not in the schema`, ns);
  }
  if (analysis.usesMe && catalog.principal === undefined) {
    fail(`${where}: rules that use me require head.principal`);
  }

  const focus: AnyFocus =
    allowable._tag === "AuthRule" ? allowable.focus : (targetFocus ?? catalog.principal?.entity ?? fail(`${where}: expression needs a focus`));
  if (allowable._tag === "AuthRule" && targetFocus !== undefined) {
    assertReusable(catalog, allowable, targetFocus, where);
  }

  return {
    rule: {
      id: ruleIdOf(ownerIdOf(focus), expr),
      focus: ownerIdOf(focus),
      expr,
      usesResource: analysis.usesResource,
      usesMe: analysis.usesMe,
      usesInput: analysis.usesInput,
      claims: [...analysis.claimKeys].sort(),
      classes: [...analysis.classNames].sort(),
      exists: analysis.exists.map((entity) => ({ entity })).sort((a, b) => a.entity.localeCompare(b.entity)),
    },
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
  targetNone: boolean,
): IrDecision => {
  const lowerArms = (arms: readonly Allowable[], side: string): string[] => {
    const ids: string[] = [];
    for (const [i, arm] of arms.entries()) {
      const at = `${where}.${side}[${i}]`;
      const { rule } = lowerRule(catalog, arm, at, targetFocus);
      if (targetNone && rule.usesResource) {
        fail(`${at}: resource-dependent rule on an operation with target "none"`);
      }
      if (rule.usesInput) {
        if (inputKeys === undefined) return fail(`${at}: input is only valid on run() rules`);
        const analysis = analyze(rule.expr);
        for (const key of analysis.inputKeys) {
          if (!inputKeys.has(key)) return fail(`${at}: input.${key} is not on the operation`);
        }
      }
      internRule(intern, rule, at);
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
  if (!isBoundOperation(op)) {
    fail(`run(${op.name}) requires withOperations — owner, localName, and target are mandatory`);
  }
  return {
    kind: "operation",
    owner: ownerIdOf(ownerOfOperation(op)!),
    localName: localNameOfOperation(op)!,
    name: op.name,
    target: targetOfOperation(op)!,
  };
};

const putOperationId = (opIds: Map<string, OperationId>, id: OperationId, where: string): void => {
  const existing = opIds.get(id.name);
  if (existing !== undefined && canonicalJson(existing) !== canonicalJson(id)) {
    fail(`${where}: operation ${id.name} is already bound to a different identity`);
  }
  opIds.set(id.name, id);
};

const principalSpec = (catalog: Catalog): PrincipalSpec => ({
  subjectClaim: "sub",
  ...(catalog.principal !== undefined
    ? { ident: catalog.principal.ident, entity: catalog.principal.entity.ns }
    : {}),
});

const compileTemplateSync = (head: AuthorizationHead, bindings: readonly AuthBinding[]): PolicyTemplateIR => {
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
    if (isBoundOperation(op as AuthOperation)) {
      putOperationId(opIds, operationIdentity(op as AuthOperation), "head.operations");
    }
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
    const id = operationIdentity(op);
    const owner = ownerOfOperation(op);
    if (owner?._tag === "Trait" && !catalog.traits.has(owner.ns)) {
      fail(`${where}: trait ${owner.ns} is not reachable in the catalog`, owner.ns);
    }
    if (owner?._tag === "Entity" && !catalog.entities.has(owner.ns)) {
      fail(`${where}: entity ${owner.ns} is not in the schema`, owner.ns);
    }
    const inputKeys = new Set(structKeys(op.input) ?? []);
    putDecision(
      operations,
      op.name,
      decisionOf(catalog, raw, where, owner, intern, inputKeys, id.target === "none"),
      `${where} run(${op.name})`,
    );
    putOperationId(opIds, id, where);
  }

  return {
    form: "template",
    version: 1,
    principal: principalSpec(catalog),
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
};

export const compileTemplate = (
  head: AuthorizationHead,
  bindings: readonly AuthBinding[],
): Effect.Effect<PolicyTemplateIR, InvalidIR> =>
  Effect.try({
    try: () => compileTemplateSync(head, bindings),
    catch: (error) =>
      error instanceof InvalidIR
        ? error
        : new InvalidIR({
            reason: error instanceof PolicyError ? error.message : String(error),
          }),
  });

/**
 * Compile bindings and install against the compile-time catalog.
 * Returns the sealed installed form runtime accepts.
 */
export const compileAuthorization = (
  head: AuthorizationHead,
  bindings: readonly AuthBinding[],
): InstalledAuthorizationIR => {
  try {
    const template = compileTemplateSync(head, bindings);
    return Effect.runSync(installAgainstCatalog(template, catalogFromTemplate(template)));
  } catch (error) {
    if (error instanceof PolicyError) throw error;
    if (error instanceof InvalidIR || error instanceof CatalogMismatch) {
      throw new PolicyError({ message: `ramose/authorization: ${error.reason}` });
    }
    if (error instanceof Error && error.message.startsWith("ramose/authorization:")) {
      throw new PolicyError({ message: error.message });
    }
    throw error;
  }
};
