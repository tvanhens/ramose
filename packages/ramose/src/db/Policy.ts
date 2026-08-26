/**
 * Typed policy authoring. The document is head/body shaped like `Query.q`:
 * the head's `principal` attr derives `me`, and every arm is a fragment
 * (or `true`, or an OR of fragments) contextually checked against that
 * token. Combinators lower to named query rules at compile; every check
 * is deploy-time.
 */

import * as Schema from "effect/Schema";
import { parseQuery } from "../internal/core/query/parse.ts";
import type { Clause, RuleDef, Term } from "../internal/core/query/ast.ts";
import { POLICY_VERSION, parsePolicy, wireOperationNeedsTarget } from "../internal/core/policy/ast.ts";
import type {
  AttrRules,
  CompiledPolicy,
  PolicyOperand,
  PolicyRuleArm,
  PolicyRules,
} from "../internal/core/policy/ast.ts";
import { POLICY_OPS } from "../internal/core/policy/ast.ts";
import { isAttrRef } from "./attrRef.ts";
import { isOptionalField, type AnyField } from "./Field.ts";
import { roleIdentOf } from "../internal/core/policy/provision.ts";
import { inferDbValueType } from "./valueTypes.ts";
import type { AnySchema } from "./Schema.ts";
import type { Eid } from "./Eid.ts";
import type { CatalogIdent } from "./idents.ts";
import type { AnyEntity } from "./Entity.ts";
import type { AnyOperation, AnyOperations, Operation } from "./Operation.ts";
import { inspectPullField, isAgain, isAllShape } from "./Pull.ts";
import {
  Q,
  lowerQueryObject,
  q,
  rule,
  type AttrLike,
  type FilterStage,
  type QueryGen,
  type ReverseFilter,
  type Var,
} from "./query/index.ts";
import { PolicyError } from "./SchemaErrors.ts";
export { PolicyError };

// ── shapes ─────────────────────────────────────────────────────────────────

export type Operand = PolicyOperand;
/** Public per-datom policy key. Writes are named operations, not datom verbs. */
export type Op = "read";
export const PUBLIC_POLICY_OPS: readonly Op[] = ["read"];

/** A stamped attribute (`User.sub`) — anything carrying `ident` + attr shape. */
export type AttrRef = AnyField & { readonly ident: string };

/**
 * The namespace the principal mapping names. `User.sub` under catalog `C`
 * yields `typeof User`, which is what brands `me`.
 */
export type NsOfPrincipal<C extends AnySchema, I extends string> = {
  [K in keyof C["entities"]]: I extends `:${C["entities"][K]["ns"]}/${string}`
    ? C["entities"][K]
    : never;
}[keyof C["entities"]];

/** `me` in every arm: a var branded with the principal's namespace. */
export type Me<N extends AnyEntity = AnyEntity> = Var<Eid<N>>;

export type PrincipalMe<C extends AnySchema, I extends string> = Me<NsOfPrincipal<C, I>>;

/**
 * Stamped field idents of an entity — the set a policy arm may mention.
 * Trait fields keep the trait's ident (`Issue.tags` → `:taggable/tags`)
 * while still belonging to the composing entity's field set.
 */
export type EntityFieldIdent<N extends AnyEntity> = {
  [K in keyof N["fields"]]: N["fields"][K] extends { readonly ident: infer I extends string }
    ? I
    : never;
}[keyof N["fields"]];

/** A stamped field of `N` — the `A` a forward `FilterStage` may capture. */
type EntityField<N extends AnyEntity> = N["fields"][keyof N["fields"]];

/**
 * `(me) => fragment` — the arm closes over the typed principal token.
 * A `Query.is` / `Query.has` filter must name a field of `N` (`InFocus`).
 * `Query.some` / `none` / `every` are `ReverseFilter` (the ref must point
 * at the focus when applied to a pipeline). `byId`, `updatedSince`, and
 * `assertedBy` are unbranded `FilterStage` (valid on every entity). A
 * handwritten generator is branded with `N` as its focus; `{ _ident?: never }`
 * keeps a wrong-entity `Query.is` from sneaking through the generator branch.
 */
export type FragFn<M, N extends AnyEntity = AnyEntity> = (me: M) =>
  | FilterStage<N, EntityField<N>>
  | FilterStage
  | ReverseFilter<AttrLike>
  | ((focus: Var<Eid<N>>) => QueryGen<unknown> & { readonly _ident?: never });

/**
 * JWT claims gate. `class` is checked before the rule runs; it never
 * grows an expression tree. `rule` defaults to `true` (public).
 */
export interface ClassGate<A = true, CL extends string = string> {
  readonly _tag: "ClassGate";
  readonly classes: readonly CL[];
  readonly arm: A;
}

export interface ClassFn<CL extends string = string> {
  readonly _tag: "ClassGate";
  readonly classes: readonly CL[];
  readonly arm: true;
  <A>(arm: A): ClassGate<A, CL>;
}

/**
 * JWT class gate as a config record — `rule` is contextually typed, so
 * inline `(me) => …` needs no annotation. `rule` defaults to `true`.
 */
export type ClassConfig<M, N extends AnyEntity = AnyEntity, CL extends string = string> = {
  readonly class: CL | readonly CL[];
  readonly rule?: true | FragFn<M, N>;
};

/** One allow arm: a fragment, `true` (empty / public), or a class gate. */
export type ArmValue<M, N extends AnyEntity = AnyEntity, CL extends string = string> =
  | true
  | FragFn<M, N>
  | ClassGate<true | FragFn<M, N>, CL>
  | ClassConfig<M, N, CL>;

/** Arms per op; an array is OR. Only `read` — writes are {@link OperationArms}. */
export type RuleSpec<M, N extends AnyEntity = AnyEntity, CL extends string = string> = {
  readonly [K in Op]?: ArmValue<M, N, CL> | readonly ArmValue<M, N, CL>[];
};

export interface AttrRule<M = unknown, N extends AnyEntity = AnyEntity, CL extends string = string> {
  readonly _tag: "AttrRule";
  readonly attr: string;
  readonly rules: RuleSpec<M, N, CL>;
}

export type NsRuleSpec<M, N extends AnyEntity = AnyEntity, CL extends string = string> = RuleSpec<
  M,
  N,
  CL
> & {
  readonly attrs?: readonly AttrRule<M, N, CL>[];
};

/**
 * Class-only arm: a bare (no-`on`) operation cannot name a rule fragment.
 * `rule` may only be `true` (or omitted).
 */
export type ClassOnlyArm<CL extends string = string> =
  | true
  | ClassGate<true, CL>
  | { readonly class: CL | readonly CL[]; readonly rule?: true };

/** An operation with `on:` takes a full arm (class + optional rule). */
export type OperationArmValue<
  O extends AnyOperation,
  M,
  CL extends string = string,
> = O extends Operation<any, any, any, infer N, any>
  ? [N] extends [undefined]
    ? ClassOnlyArm<CL> | readonly ClassOnlyArm<CL>[]
    : N extends AnyEntity
      ? ArmValue<M, N, CL> | readonly ArmValue<M, N, CL>[]
      : ClassOnlyArm<CL> | readonly ClassOnlyArm<CL>[]
  : ClassOnlyArm<CL> | readonly ClassOnlyArm<CL>[];

/** Typed keys off the registry — no string op names in app code. */
export type OperationArms<
  Ops extends AnyOperations,
  M,
  CL extends string = string,
> = {
  readonly [K in keyof Ops["operations"]]?: OperationArmValue<Ops["operations"][K], M, CL>;
};

export interface PolicyHead<
  C extends AnySchema = AnySchema,
  CL extends readonly string[] = readonly string[],
  CF extends Schema.Struct.Fields = Schema.Struct.Fields,
> {
  readonly schema: C;
  /** attribute whose value is the JWT `sub` — derives `me`'s type */
  readonly principal: AttrRef & { readonly ident: CatalogIdent<C> };
  readonly classes: CL;
  /**
   * Class whose holders bypass every rule. `P.class(superuser)` in an
   * arm is unreachable and rejected. Omit to have no bypass class.
   */
  readonly superuser?: CL[number];
  /**
   * Classes that may install or grow schema. Defaults to `[superuser]`.
   * Distinct from bypass — a schema class still runs the rules.
   */
  readonly schemaClasses?: readonly CL[number][];
  /** shape of `ramose.attrs` */
  readonly claims?: Schema.Struct<CF>;
  /** The app's operations registry — types the body's `operations:` keys. */
  readonly operations?: AnyOperations;
}

export type PolicyArms<
  C extends AnySchema,
  M,
  CL extends readonly string[] = readonly string[],
  Ops extends AnyOperations | undefined = undefined,
> = {
  readonly [K in keyof C["entities"]]?: NsRuleSpec<M, C["entities"][K], CL[number]>;
} & (Ops extends AnyOperations
  ? { readonly operations?: OperationArms<Ops, M, CL[number]> }
  : { readonly operations?: undefined });

interface CompiledArm {
  readonly classes?: readonly string[];
  readonly rule: true | string;
}

interface NsRules {
  readonly prefix: string;
  readonly rules: Readonly<Record<string, readonly CompiledArm[]>>;
  readonly attrs: Readonly<Record<string, Readonly<Record<string, readonly CompiledArm[]>>>>;
}

/** A policy bound to its catalog. `compile` lowers it to the wire JSON. */
export interface Policy<
  C extends AnySchema = AnySchema,
  CL extends readonly string[] = readonly string[],
  SU extends CL[number] | undefined = CL[number] | undefined,
> {
  readonly _tag: "Policy";
  readonly schema: C;
  readonly principal: string;
  readonly classes: CL;
  readonly superuser?: SU;
  readonly schemaClasses: readonly CL[number][];
  readonly claims?: Schema.Struct<Schema.Struct.Fields>;
  /** catalog namespace key → normalised rules */
  readonly ns: Readonly<Record<string, NsRules>>;
  /** wire op name → compiled arms */
  readonly operations: Readonly<Record<string, readonly CompiledArm[]>>;
  /** registered op names with no arm — superuser-only */
  readonly unarmedOperations: readonly string[];
  /** lowered query-engine rule definitions */
  readonly ruleDefs: readonly unknown[];
  /** idents whose attribute rule narrows their namespace's `read` */
  readonly maskedReads: ReadonlySet<string>;
}

/** The declared classes of a policy value: `Ramose.Policy.Class<typeof policy>`. */
export type Class<P extends { readonly classes: readonly string[] }> = P["classes"][number];

const fail = (message: string, ident?: string, cause?: unknown): never => {
  throw new PolicyError({
    message: `ramose/policy: ${message}`,
    ...(ident !== undefined && { ident }),
    ...(cause !== undefined && { cause }),
  });
};

/** Keep `CL` inferred from the head, not widened by arm literals. */
type NoInfer<T> = [T][T extends unknown ? 0 : never];

/** Arm class names: the head's `classes` minus `superuser` (unreachable). */
type ArmClasses<CL extends readonly string[], SU> = readonly Exclude<CL[number], SU>[];

/** Runtime fragment: promote does not re-check the type-level brand. */
type AnyFragFn = (me: Var<unknown>) => (focus: Var<unknown>) => QueryGen<unknown>;

// ── claims ─────────────────────────────────────────────────────────────────

export type ClaimOperand = { readonly _tag: "claim"; readonly path: readonly string[] };

export interface ClaimAccess<Attrs> {
  readonly sub: ClaimOperand;
  readonly iss: ClaimOperand;
  readonly aud: ClaimOperand;
  readonly exp: ClaimOperand;
  /** app claims (`ramose.attrs`) */
  readonly attrs: Attrs;
}

const attrsProxy = <T>(): T =>
  new Proxy({} as Record<string, ClaimOperand>, {
    get: (_t, key) =>
      typeof key === "string"
        ? ({ _tag: "claim", path: ["attrs", key] } as ClaimOperand)
        : undefined,
  }) as T;

const claimAccess = <T>(): ClaimAccess<T> => ({
  sub: { _tag: "claim", path: ["sub"] },
  iss: { _tag: "claim", path: ["iss"] },
  aud: { _tag: "claim", path: ["aud"] },
  exp: { _tag: "claim", path: ["exp"] },
  attrs: attrsProxy<T>(),
});

/** `P.claim.sub`, `P.claim.attrs.org`. */
export const claim: ClaimAccess<Record<string, ClaimOperand>> = claimAccess();

/** Same accessor with `attrs` keyed by a claims struct: `P.claimOf(S).attrs.org`. */
export const claimOf = <CF extends Schema.Struct.Fields>(
  _struct: Schema.Struct<CF>,
): ClaimAccess<{ readonly [K in keyof CF & string]: ClaimOperand }> =>
  claimAccess<{ readonly [K in keyof CF & string]: ClaimOperand }>();

/** The principal's resolved entity id — a claim-style operand, not a rule. */
export const principal: Operand = { _tag: "principal" };

const identOf = (a: AttrRef): string => {
  if (!isAttrRef(a)) fail(`expected an attribute ref, got ${String(a)}`);
  return a.ident;
};

const isClassGate = (v: unknown): v is ClassGate<unknown> =>
  (typeof v === "object" || typeof v === "function") &&
  v !== null &&
  (v as { _tag?: unknown })._tag === "ClassGate";

const isClassConfig = (v: unknown): v is ClassConfig<unknown> =>
  typeof v === "object" &&
  v !== null &&
  !Array.isArray(v) &&
  !isClassGate(v) &&
  "class" in v &&
  (v as { _tag?: unknown })._tag !== "AttrRule";

/**
 * JWT class gate. `P.class("member")` is a public arm for that class;
 * `P.class("member")(frag)` / `{ class: "member", rule: frag }` compose
 * the gate with a fragment. Checked before the rule runs; never an
 * expression.
 */
export const classFn = <const Cls extends string>(...classes: Cls[]): ClassFn<Cls> => {
  if (classes.length === 0) fail("P.class needs at least one class name");
  for (const c of classes) {
    if (typeof c !== "string" || c.length === 0) fail("P.class names must be non-empty strings");
  }
  const apply = ((arm: unknown) => ({
    _tag: "ClassGate" as const,
    classes,
    arm,
  })) as unknown as ClassFn<Cls>;
  return Object.assign(apply, { _tag: "ClassGate" as const, classes, arm: true as const });
};
export { classFn as class };

/** Field rule; narrows (ANDs with) its entity rule. Only `read` arms. */
export const field = <
  A extends AttrRef,
  M,
  N extends AnyEntity = AnyEntity,
  CL extends string = string,
>(
  a: A,
  rules: RuleSpec<M, N, CL>,
): AttrRule<M, N, CL> => ({
  _tag: "AttrRule",
  attr: identOf(a),
  rules,
});

// ── compile fragments → named rules ────────────────────────────────────────

const catalogIdents = (schema: AnySchema): ReadonlySet<string> => {
  const out = new Set<string>();
  for (const ns of Object.values(schema.entities)) {
    for (const ident of entityFieldIdents(ns)) out.add(ident);
  }
  return out;
};

/** Stamped idents on `entity.fields` — not `:${ns}/${key}`, so trait fields count. */
const entityFieldIdents = (entity: {
  readonly fields: Readonly<Record<string, { readonly ident?: unknown }>>;
}): Set<string> => {
  const out = new Set<string>();
  for (const field of Object.values(entity.fields)) {
    if (typeof field?.ident === "string") out.add(field.ident);
  }
  return out;
};

const IDENT_RE = /^:[^/]+\/[^/]+$/;

const walkIdents = (x: unknown, visit: (ident: string) => void): void => {
  if (typeof x === "string") {
    if (IDENT_RE.test(x)) visit(x);
    return;
  }
  if (Array.isArray(x)) {
    for (const y of x) walkIdents(y, visit);
  }
};

const isFragFn = (v: unknown): v is AnyFragFn => typeof v === "function" && !isClassGate(v);

const asClassList = (c: string | readonly string[], where: string): readonly string[] => {
  const list = typeof c === "string" ? [c] : [...c];
  if (list.length === 0) fail(`${where}: class gate needs at least one class`);
  return list;
};

const unwrapGate = (
  v: ArmValue<unknown>,
): { readonly classes?: readonly string[]; readonly body: true | AnyFragFn } => {
  if (v === true) return { body: true };
  if (isClassGate(v)) {
    const inner = v.arm === undefined ? true : v.arm;
    if (inner !== true && !isFragFn(inner)) {
      fail("P.class(...) wraps a fragment or true");
    }
    return { classes: v.classes, body: inner as true | AnyFragFn };
  }
  if (isClassConfig(v)) {
    const inner = v.rule === undefined ? true : v.rule;
    if (inner !== true && !isFragFn(inner)) {
      fail("a class gate's rule is a fragment or true");
    }
    return { classes: asClassList(v.class, "class"), body: inner as true | AnyFragFn };
  }
  if (isFragFn(v)) return { body: v };
  return fail("an arm is a fragment, true, or a class gate");
};

const promote = (
  name: string,
  frag: AnyFragFn,
  where: string,
): ReturnType<typeof rule> => {
  const body = function* (me: Var<unknown>, e: Var<unknown>): QueryGen<void> {
    const produced = frag(me);
    if (typeof produced !== "function") {
      fail(`${where}: a fragment is (me) => (focus) => … — got ${typeof produced}`);
    }
    yield* produced(e);
  };
  const named = rule(name, body as never);
  try {
    const built = named.ensureBuilt();
    if (built.clauses.length === 0) {
      fail(`${where}: empty fragment — use true for a public arm`);
    }
  } catch (cause) {
    if (cause instanceof PolicyError) throw cause;
    fail(`${where}: ${cause instanceof Error ? cause.message : String(cause)}`, undefined, cause);
  }
  return named;
};

const lowerNamedRules = (named: readonly ReturnType<typeof rule>[]): unknown[] => {
  if (named.length === 0) return [];
  const dummy = q(function* () {
    const me = Q.var();
    const e = Q.var();
    for (const r of named) yield* r(me, e);
    return e;
  });
  try {
    const { query } = lowerQueryObject(dummy);
    return Array.isArray(query.rules) ? (query.rules as unknown[]) : [];
  } catch (cause) {
    return fail(`rule lowering failed: ${cause instanceof Error ? cause.message : String(cause)}`, undefined, cause);
  }
};

const parseRuleDefs = (
  defs: readonly unknown[],
  idents: ReadonlySet<string>,
  where: string,
): readonly RuleDef[] => {
  if (defs.length === 0) return [];
  let parsed: ReturnType<typeof parseQuery>;
  try {
    parsed = parseQuery({ find: ["?e"], where: [], rules: defs });
  } catch (cause) {
    return fail(
      `${where}: rule body failed query validation: ${cause instanceof Error ? cause.message : String(cause)}`,
      undefined,
      cause,
    );
  }
  walkIdents(defs, (ident) => {
    if (ident.startsWith(":db/")) return;
    if (!idents.has(ident)) fail(`${where}: ${ident} is not in the schema`, ident);
  });
  return parsed.rules ?? [];
};

const termVar = (t: Term): string | undefined => (t.kind === "var" ? t.name : undefined);

const attrIdent = (t: Term): string | undefined =>
  t.kind === "const" && typeof t.value === "string" ? t.value : undefined;

/**
 * True when `focus` is bound as the arm entity: the e-slot of one of this
 * entity's fields (or a `:db/` / wildcard pattern), the value-slot of a
 * generating fact (a backlink / reverse ref), `ground`, or a named-rule
 * argument that is bound that way in the callee. An e-slot of a *foreign*
 * ident does not count — `[?comment :doc/owner ?me]` matches nothing.
 */
const bindsFocusAsEntity = (
  focus: string,
  clauses: readonly Clause[],
  fieldIdents: ReadonlySet<string>,
  byName: ReadonlyMap<string, readonly RuleDef[]>,
  visiting: Set<string>,
): boolean => {
  for (const c of clauses) {
    switch (c.kind) {
      case "pattern": {
        if (termVar(c.v) === focus) return true;
        if (termVar(c.e) === focus) {
          const ident = attrIdent(c.a);
          if (ident === undefined || ident.startsWith(":db/") || fieldIdents.has(ident)) {
            return true;
          }
        }
        break;
      }
      case "rule-call": {
        const defs = byName.get(c.name);
        if (defs === undefined) break;
        for (let i = 0; i < c.args.length; i++) {
          if (termVar(c.args[i]!) !== focus) continue;
          for (const def of defs) {
            const headVar = def.args[i];
            if (headVar === undefined) continue;
            const key = `${def.name}\0${headVar}`;
            if (visiting.has(key)) continue;
            visiting.add(key);
            const hit = bindsFocusAsEntity(headVar, def.clauses, fieldIdents, byName, visiting);
            visiting.delete(key);
            if (hit) return true;
          }
        }
        break;
      }
      case "or":
        if (c.branches.some((b) => bindsFocusAsEntity(focus, b, fieldIdents, byName, visiting))) {
          return true;
        }
        break;
      case "fn":
        if (c.fn === "ground" && c.binding.kind === "scalar" && c.binding.var === focus) {
          return true;
        }
        break;
      default:
        break;
    }
  }
  return false;
};

/**
 * A rule that never binds the arm's focus as that entity is a silent deny
 * (deny-by-default) or an unbound `?e` at evaluation. The check is "the
 * focus appears in a generating position that names this entity" — an
 * own-field e-slot, a reverse-ref value-slot, or a named `Query.rule`
 * that does one of those — not "this def's clauses mention an own ident".
 * A backlink arm and an arm that only invokes a named rule both bind the
 * focus without mentioning a field of the arm entity in that one def.
 */
const checkArmFocus = (
  parsed: readonly RuleDef[],
  ruleArmMeta: ReadonlyMap<string, { readonly fieldIdents: ReadonlySet<string>; readonly where: string }>,
): void => {
  const byName = new Map<string, RuleDef[]>();
  for (const d of parsed) {
    const list = byName.get(d.name);
    if (list) list.push(d);
    else byName.set(d.name, [d]);
  }
  for (const [name, meta] of ruleArmMeta) {
    const defs = byName.get(name);
    if (defs === undefined) continue;
    for (const def of defs) {
      // promote() is `rule(name, (me, e) => …)` — focus is the second head var.
      const focus = def.args[1];
      if (focus === undefined) continue;
      if (!bindsFocusAsEntity(focus, def.clauses, meta.fieldIdents, byName, new Set())) {
        fail(`${meta.where}: rule never binds the focus as this entity`);
      }
    }
  }
};

// ── authoring ──────────────────────────────────────────────────────────────

/**
 * Build a policy. `policy(head, arms)` is head/body shaped like `Query.q`:
 * `principal: User.sub` derives `me`, and every inline arm is checked as
 * `(me) => fragment` with `me` fully typed. Writes are the `operations:`
 * section — keys are the app registry's bindings, lowered to op names on
 * the wire. Unknown idents, undeclared classes and unknown namespace keys
 * fail here. `superuser` / `schemaClasses` are required to resolve to at
 * least one class that may install schema; `P.class(superuser)` in an arm
 * is unreachable and rejected.
 */
export function policy<
  const C extends AnySchema,
  const I extends CatalogIdent<C>,
  const CL extends readonly string[],
  const SU extends CL[number] | undefined = undefined,
  CF extends Schema.Struct.Fields = Schema.Struct.Fields,
  const Ops extends AnyOperations | undefined = undefined,
>(
  head: {
    readonly schema: C;
    readonly principal: AttrRef & { readonly ident: I };
    readonly classes: CL;
    readonly superuser?: SU & CL[number];
    readonly schemaClasses?: readonly CL[number][];
    readonly claims?: Schema.Struct<CF>;
    readonly operations?: Ops;
  },
  arms: PolicyArms<C, PrincipalMe<C, I>, NoInfer<ArmClasses<CL, SU>>, Ops>,
): Policy<C, CL, SU> {
  if (head == null || typeof head !== "object" || head.schema == null) {
    fail("policy(head, arms) takes a head { schema, principal, classes }");
  }
  const schema = head.schema;
  if ((schema as { _tag?: unknown })._tag !== "Schema") {
    fail("head.schema must be a Ramose.Schema");
  }
  if (arms == null || typeof arms !== "object") {
    fail("policy(head, arms) takes the entity arms as its second argument");
  }

  const idents = catalogIdents(schema);
  const principalIdent = identOf(head.principal as AttrRef);
  if (!idents.has(principalIdent)) fail(`principal ${principalIdent} is not in the schema`, principalIdent);
  checkPrincipalProvisioning(schema, principalIdent);

  const classes = head.classes;
  if (classes.length === 0) fail("classes must not be empty");
  if (new Set(classes).size !== classes.length) fail("duplicate class");
  const classSet = new Set<string>(classes);

  const superuser = head.superuser;
  if (superuser !== undefined) {
    if (typeof superuser !== "string" || superuser.length === 0) {
      fail("superuser must be a declared class name");
    }
    if (!classSet.has(superuser)) {
      fail(`superuser ${JSON.stringify(superuser)} is not a declared class`);
    }
  }

  const schemaClasses: readonly string[] = (() => {
    if (head.schemaClasses !== undefined) {
      const list = [...head.schemaClasses];
      if (list.length === 0) fail("schemaClasses must not be empty");
      if (new Set(list).size !== list.length) fail("duplicate schema class");
      for (const c of list) {
        if (!classSet.has(c)) fail(`schemaClasses: ${JSON.stringify(c)} is not a declared class`);
      }
      return list;
    }
    if (superuser !== undefined) return [superuser];
    return fail("no class can install schema — set schemaClasses or superuser");
  })();

  const checkClasses = (gate: readonly string[] | undefined, where: string): void => {
    if (gate === undefined) return;
    for (const c of gate) {
      if (!classSet.has(c)) fail(`${where}: ${JSON.stringify(c)} is not a declared class`);
      if (superuser !== undefined && c === superuser) {
        fail(
          `${where}: P.class(${JSON.stringify(superuser)}) is unreachable — the superuser bypasses every rule`,
        );
      }
    }
  };

  const pending: ReturnType<typeof rule>[] = [];
  const seenFrags = new Map<AnyFragFn, Map<string, string>>();
  const ruleArmMeta = new Map<string, { readonly fieldIdents: ReadonlySet<string>; readonly where: string }>();
  let nextRule = 0;

  const compileArm = (
    raw: ArmValue<unknown>,
    where: string,
    prefix: string,
    op: string,
    entityKey: string,
    fieldIdents: ReadonlySet<string>,
  ): CompiledArm => {
    const { classes: gate, body } = unwrapGate(raw);
    checkClasses(gate, where);
    if (body === true) {
      return gate === undefined ? { rule: true } : { classes: gate, rule: true };
    }
    const byEntity = seenFrags.get(body);
    const existing = byEntity?.get(entityKey);
    const name = existing ?? `policy/${prefix}/${op}/${nextRule++}`;
    if (existing === undefined) {
      pending.push(promote(name, body, where));
      if (byEntity === undefined) seenFrags.set(body, new Map([[entityKey, name]]));
      else byEntity.set(entityKey, name);
      ruleArmMeta.set(name, { fieldIdents, where });
    }
    return gate === undefined ? { rule: name } : { classes: gate, rule: name };
  };

  const compileSpec = (
    spec: RuleSpec<unknown>,
    where: string,
    prefix: string,
    entityKey: string,
    fieldIdents: ReadonlySet<string>,
  ): Record<string, readonly CompiledArm[]> => {
    const out: Record<string, CompiledArm[]> = {};
    for (const op of PUBLIC_POLICY_OPS) {
      const v = spec[op];
      if (v === undefined) continue;
      const list = Array.isArray(v) ? (v as readonly ArmValue<unknown>[]) : [v as ArmValue<unknown>];
      if (list.length === 0) continue;
      out[op] = list.map((arm, i) =>
        compileArm(arm, `${where}.${op}${list.length > 1 ? `[${i}]` : ""}`, prefix, op, entityKey, fieldIdents),
      );
    }
    return out;
  };

  const REJECTED_WRITE_KEYS = new Set(["set", "remove", "delete", "create", "preset"]);

  const ns: Record<string, NsRules> = {};
  const maskedReads = new Set<string>();
  const body = arms as Record<string, unknown>;
  const operationSpec = body.operations as Record<string, unknown> | undefined;

  for (const [nsKey, rawSpec] of Object.entries(body)) {
    if (nsKey === "operations" || rawSpec === undefined) continue;
    const nsSpec = rawSpec as NsRuleSpec<unknown> & Record<string, unknown>;
    for (const key of Object.keys(nsSpec)) {
      if (REJECTED_WRITE_KEYS.has(key)) {
        fail(
          `ns.${nsKey}.${key}: write verbs are gone — authorize ${key} on the named operation in operations:`,
        );
      }
    }
    const declared = (
      schema.entities as Record<
        string,
        { ns: string; fields: Record<string, { readonly ident?: unknown }> } | undefined
      >
    )[nsKey];
    if (declared === undefined) fail(`ns key ${JSON.stringify(nsKey)} is not in the schema`);
    const entity = declared!;
    const prefix = entity.ns;
    const where = `ns.${nsKey}`;
    const fieldIdents = entityFieldIdents(entity);

    const rules = compileSpec(nsSpec, where, prefix, prefix, fieldIdents);

    const attrs: Record<string, Record<string, readonly CompiledArm[]>> = {};
    for (const a of nsSpec.attrs ?? []) {
      if (a?._tag !== "AttrRule") fail(`${where}.attrs expects P.field(...)`);
      if (!idents.has(a.attr)) fail(`${where}.attrs: ${a.attr} is not in the schema`, a.attr);
      if (!fieldIdents.has(a.attr)) {
        fail(`${where}.attrs: ${a.attr} is not a field of the ${nsKey} entity`, a.attr);
      }
      for (const key of Object.keys(a.rules as object)) {
        if (REJECTED_WRITE_KEYS.has(key)) {
          fail(`${where}.attrs["${a.attr}"].${key}: attribute write arms are gone — use operations:`);
        }
      }
      const r = compileSpec(
        a.rules,
        `${where}.attrs["${a.attr}"]`,
        `${prefix}/${a.attr.slice(a.attr.lastIndexOf("/") + 1)}`,
        prefix,
        fieldIdents,
      );
      attrs[a.attr] = r;
      if (r.read !== undefined) maskedReads.add(a.attr);
    }

    ns[nsKey] = { prefix, rules, attrs };
  }

  const compiledOps: Record<string, readonly CompiledArm[]> = {};
  const registry = head.operations;
  if (operationSpec !== undefined) {
    if (registry === undefined || registry._tag !== "Operations") {
      fail("operations: needs the registry on the policy head (head.operations)");
    }
    const bound = (registry as AnyOperations).operations as Record<string, AnyOperation>;
    for (const [key, raw] of Object.entries(operationSpec)) {
      if (raw === undefined) continue;
      const operation = bound[key];
      if (operation === undefined || operation._tag !== "Operation") {
        fail(`operations.${key}: ${JSON.stringify(key)} is not a key of the registry`);
      }
      const wireName = operation.name;
      if (typeof wireName !== "string" || wireName.length === 0) {
        fail(`operations.${key}: operation has no name`);
      }
      const list = Array.isArray(raw) ? raw : [raw];
      if (list.length === 0) continue;
      const on = operation.on as
        | { readonly ns?: string; readonly fields: Record<string, { readonly ident?: unknown }> }
        | undefined;
      const fieldIdents = on !== undefined ? entityFieldIdents(on) : new Set<string>();
      const entityKey = on?.ns ?? `op/${wireName}`;
      compiledOps[wireName] = list.map((arm, i) => {
        const where = `operations.${key}${list.length > 1 ? `[${i}]` : ""}`;
        const { body } = unwrapGate(arm as ArmValue<unknown>);
        if (body !== true && on === undefined) {
          fail(`${where}: a bare (no-on) operation takes a class gate only`);
        }
        return compileArm(
          arm as ArmValue<unknown>,
          where,
          `op/${wireName}`,
          "run",
          entityKey,
          fieldIdents,
        );
      });
    }
  }

  const registeredNames = registry !== undefined ? [...registry.names()] : [];
  const armed = new Set(Object.keys(compiledOps));
  const unarmedOperations = registeredNames.filter((n) => !armed.has(n));

  const ruleDefs = lowerNamedRules(pending);
  const parsedRules = parseRuleDefs(ruleDefs, idents, "rules");
  checkArmFocus(parsedRules, ruleArmMeta);

  return {
    _tag: "Policy",
    schema,
    principal: principalIdent,
    classes,
    ...(superuser !== undefined ? { superuser } : {}),
    schemaClasses,
    ...(head.claims !== undefined
      ? { claims: head.claims as Schema.Struct<Schema.Struct.Fields> }
      : {}),
    ns,
    operations: compiledOps,
    unarmedOperations,
    ruleDefs,
    maskedReads,
  };
}

const claimsJson = (struct: Schema.Struct<Schema.Struct.Fields> | undefined): unknown => {
  if (struct === undefined) return undefined;
  try {
    return Schema.toJsonSchemaDocument(struct);
  } catch {
    return { keys: Object.keys(struct.fields) };
  }
};

const toWireArm = (a: CompiledArm): PolicyRuleArm =>
  a.classes === undefined ? { _tag: "allow", rule: a.rule } : { _tag: "allow", class: a.classes, rule: a.rule };

const toWireRules = (rules: Readonly<Record<string, readonly CompiledArm[]>>): PolicyRules => {
  const out: Record<string, readonly PolicyRuleArm[]> = {};
  for (const op of POLICY_OPS) {
    const arms = rules[op];
    if (arms) out[op] = arms.map(toWireArm);
  }
  return out as PolicyRules;
};

/**
 * Lower to the compiled AST. Namespace rules are emitted once, under `ns`
 * (entity prefixes only — trait prefixes are not fanned out). `allowsOp`
 * remaps a trait attr to the entity's `:ramose/type` namespace so two
 * composers of the same trait do not union their grants. `attrs` carries
 * only the attributes that narrow their namespace. Core ANDs
 * `attrs[ident][op]` with `ns[prefix][op]` and falls back to whichever side is
 * present (internal/core/policy/eval.ts#allowsOp), so an attribute inherits its
 * namespace without being named and an attribute rule is emitted alone — core
 * supplies the narrowing. A trait attr with no rule on the entity type denies.
 *
 * Fragment arms compile to named query rules in `rules`; `true` is the empty
 * fragment (public) and does not emit a rule. `RAMOSE_POLICY` is a Cloudflare
 * plain-text binding capped at 5.1 kB, so only surviving read / operation
 * arms and the rules they need are serialised.
 */
const lower = (p: Policy): CompiledPolicy => {
  const attrs: Record<string, AttrRules> = {};
  const ns: Record<string, PolicyRules> = {};

  const attrOwners = new Map<string, string>();
  for (const [nsKey, entry] of Object.entries(p.ns)) {
    const declared = (
      p.schema.entities as Record<
        string,
        { fields: Readonly<Record<string, { readonly ident?: unknown }>> }
      >
    )[nsKey]!;
    if (Object.keys(entry.rules).length > 0) ns[entry.prefix] = toWireRules(entry.rules);

    const declaredIdents = entityFieldIdents(declared);
    for (const [ident, own] of Object.entries(entry.attrs)) {
      if (!declaredIdents.has(ident)) fail(`ns.${nsKey}.attrs: ${ident} is not in the schema`, ident);
      const narrowed = toWireRules(own);
      if (Object.keys(narrowed).length === 0) continue;
      const existing = attrs[ident];
      if (existing !== undefined) {
        if (JSON.stringify(existing) !== JSON.stringify(narrowed)) {
          fail(
            `ns.${nsKey}.attrs: ${ident} conflicts with ns.${attrOwners.get(ident)}`,
            ident,
          );
        }
        continue;
      }
      attrs[ident] = narrowed;
      attrOwners.set(ident, nsKey);
    }
  }

  const operations: Record<string, readonly PolicyRuleArm[]> = {};
  for (const [name, arms] of Object.entries(p.operations)) {
    operations[name] = arms.map(toWireArm);
  }

  return {
    version: POLICY_VERSION,
    principal: p.principal,
    classes: p.classes,
    ...(p.superuser !== undefined ? { superuser: p.superuser } : {}),
    schemaClasses: p.schemaClasses,
    claims: claimsJson(p.claims),
    attrs,
    ns,
    ...(Object.keys(operations).length > 0 ? { operations } : {}),
    ...(p.ruleDefs.length > 0 ? { rules: p.ruleDefs } : {}),
  };
};

export interface CompileOptions {
  /** app pull patterns, checked for read-masked attributes used as required */
  readonly pulls?: readonly unknown[];
  /**
   * The operations registry this deploy ships. Every `operations:` key
   * must be a registered op; a rule arm on a registry-bare op fails.
   * Registered ops with no arm are listed as superuser-only.
   */
  readonly operations?: AnyOperations;
}

/**
 * Deploy-time coverage: every armed name must be in the registry.
 * A named-rule or db-dependent v1 arm on a registry-bare (no-`on`) op
 * is rejected — those arms need a resolved target. Unarmed registered
 * ops are returned — they deny everyone but superuser.
 */
export const checkOperationsPolicyCoverage = (
  registry: AnyOperations,
  armed: ReadonlySet<string> | readonly string[] | Readonly<Record<string, unknown>>,
): { readonly unarmed: readonly string[] } => {
  const names = new Set(registry.names());
  const isMap =
    typeof armed === "object" &&
    armed !== null &&
    !Array.isArray(armed) &&
    !(armed instanceof Set);
  const have = isMap
    ? new Set(Object.keys(armed as Record<string, unknown>))
    : armed instanceof Set
      ? armed
      : new Set(armed);
  for (const name of have) {
    if (!names.has(name)) {
      fail(
        `operations: ${JSON.stringify(name)} is not in the registry — typed keys lower to the operation's name`,
      );
    }
  }
  if (isMap) {
    const ops = armed as Record<string, unknown>;
    for (const name of have) {
      const operation = registry.get(name);
      if (operation === undefined || operation.on !== undefined) continue;
      if (wireOperationNeedsTarget(ops[name])) {
        fail(
          `operations.${name}: a bare (no-on) operation takes a class gate only`,
        );
      }
    }
  }
  return { unarmed: [...names].filter((n) => !have.has(n)).sort() };
};

const isStringField = (field: AnyField): boolean =>
  inferDbValueType(field.schema, field.valueType) === "string";

/**
 * Fail closed at deploy: only the principal ident, a string-typed
 * `role` sibling, and optional / card-many fields are provisionable.
 * The peer writes `role` only when that attr is string-typed — a
 * required card-one non-string `role` is not provisionable. The peer
 * *may* stamp matching `ramose.attrs` at login, but those keys are
 * per-token and never guaranteed — they do not make a required field
 * provisionable. A required card-one field beyond principal + string
 * role makes first login `tx/required`. Mark those fields
 * `optional: true` (or use a schema AST that admits `undefined`).
 */
export const checkPrincipalProvisioning = (
  schema: AnySchema,
  principalIdent: string,
): void => {
  const entity = Object.values(schema.entities).find((e) => entityFieldIdents(e).has(principalIdent));
  if (entity === undefined) return;
  const roleIdent = roleIdentOf(principalIdent);
  const missing: string[] = [];
  for (const field of Object.values(entity.fields)) {
    const ident = typeof field.ident === "string" ? field.ident : undefined;
    if (ident === undefined) continue;
    if (ident === principalIdent) continue;
    if (ident === roleIdent && isStringField(field as AnyField)) continue;
    if (isOptionalField(field as AnyField)) continue;
    missing.push(ident);
  }
  if (missing.length === 0) return;
  const listed = missing.join(", ");
  const one = missing.length === 1;
  fail(
    `principal entity ${entity.ns} has required field${one ? "" : "s"} the peer does not write: ${listed} — mark ${one ? "it" : "them"} optional: true or first login is tx/required`,
    missing[0],
  );
};

/**
 * `reshapePullResult` drops an entity that is missing a *required* key, so a
 * read-masked attribute pulled as required would delete the row instead of
 * redacting the field. Deploy-time error, not a printed list.
 *
 * `.orDefault(v)` is required for this purpose, deliberately: it is not a way
 * to keep the row. The masked datom comes back absent, so the default would
 * *stand in* for it — the caller reads `v` as if it were the hidden value,
 * which is worse than the `undefined` `.optional` gives them. Fail closed:
 * only `.optional` (or a card-many field, which is `[]`) passes.
 */
export const checkPulls = (p: Policy, pulls: readonly unknown[]): void => {
  if (p.maskedReads.size === 0) return;
  const walk = (pattern: unknown, where: string): void => {
    if (
      pattern === null ||
      typeof pattern !== "object" ||
      Array.isArray(pattern) ||
      isAllShape(pattern) ||
      isAgain(pattern)
    ) {
      return;
    }
    for (const [key, field] of Object.entries(pattern as Record<string, unknown>)) {
      const info = inspectPullField(field);
      const ident = isAttrRef(info.attr)
        ? info.attr.ident
        : typeof info.attr === "string"
          ? info.attr
          : undefined;
      if (ident !== undefined && p.maskedReads.has(ident) && !info.optional && !info.many) {
        fail(
          `${where}.${key}: ${ident} has a narrowed read rule and must be pulled as \`.optional\`` +
            (info.hasDefault
              ? " — `.orDefault` does not qualify: it would stand in for the redacted value"
              : ""),
          ident,
        );
      }
      if (info.nestedPattern !== undefined) walk(info.nestedPattern, `${where}.${key}`);
    }
  };
  pulls.forEach((pattern, i) => walk(pattern, `pulls[${i}]`));
};

/** Compile to the wire JSON. Round-tripped through core's `parsePolicy`. */
export const compile = (p: Policy, options?: CompileOptions): string => {
  if (p?._tag !== "Policy") fail("compile() expects a policy(...) value");
  checkPrincipalProvisioning(p.schema, p.principal);
  if (options?.pulls) checkPulls(p, options.pulls);
  if (options?.operations !== undefined) {
    checkOperationsPolicyCoverage(options.operations, p.operations);
  }
  const compiled = lower(p);
  const json = JSON.stringify(compiled);
  try {
    parsePolicy(JSON.parse(json));
  } catch (cause) {
    fail(`compiled policy failed core validation: ${(cause as Error).message}`, undefined, cause);
  }
  return json;
};
