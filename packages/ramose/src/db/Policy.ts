/**
 * Typed policy authoring. The document is head/body shaped like `Query.q`:
 * the head's `principal` attr derives `me`, and every arm is a fragment
 * (or `true`, or an OR of fragments) contextually checked against that
 * token. Combinators lower to named query rules at compile; every check
 * is deploy-time.
 */

import * as Schema from "effect/Schema";
import { parseQuery } from "../internal/core/query/parse.ts";
import { POLICY_VERSION, parsePolicy } from "../internal/core/policy/ast.ts";
import type {
  AttrRules,
  CompiledPolicy,
  PolicyOperand,
  PolicyOp,
  PolicyRuleArm,
  PolicyRules,
} from "../internal/core/policy/ast.ts";
import { POLICY_OPS } from "../internal/core/policy/ast.ts";
import { isAttrRef } from "./attrRef.ts";
import type { AnyField } from "./Field.ts";
import type { AnySchema } from "./Schema.ts";
import type { Eid } from "./Eid.ts";
import type { CatalogIdent } from "./idents.ts";
import type { AnyEntity } from "./Entity.ts";
import { inspectPullField, isAgain, isAllShape } from "./Pull.ts";
import { Q, lowerQueryObject, q, rule, type Fragment, type QueryGen, type Var } from "./query/index.ts";
import { PolicyError } from "./SchemaErrors.ts";

// ── shapes ─────────────────────────────────────────────────────────────────

export type Operand = PolicyOperand;
export type Op = PolicyOp;

/** A stamped attribute (`User.sub`) — anything carrying `ident` + attr shape. */
export type AttrRef = AnyField & { readonly ident: string };

export interface Preset {
  readonly _tag: "Preset";
  readonly attr: string;
  readonly operand: Operand;
}

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

/** `(me) => fragment` — the arm closes over the typed principal token. */
export type FragFn<M> = (me: M) => Fragment<Var<unknown>, unknown>;

/**
 * JWT claims gate. `class` is checked before the rule runs; it never
 * grows an expression tree. `rule` defaults to `true` (public).
 */
export interface ClassGate<A = true> {
  readonly _tag: "ClassGate";
  readonly classes: readonly string[];
  readonly arm: A;
}

export interface ClassFn {
  readonly _tag: "ClassGate";
  readonly classes: readonly string[];
  readonly arm: true;
  <A>(arm: A): ClassGate<A>;
}

/**
 * JWT class gate as a config record — `rule` is contextually typed, so
 * inline `(me) => …` needs no annotation. `rule` defaults to `true`.
 */
export type ClassConfig<M> = {
  readonly class: string | readonly string[];
  readonly rule?: true | FragFn<M>;
};

/** One allow arm: a fragment, `true` (empty / public), or a class gate. */
export type ArmValue<M> = true | FragFn<M> | ClassGate<true | FragFn<M>> | ClassConfig<M>;

/** Arms per op; an array is OR. */
export type RuleSpec<M> = {
  readonly [K in Op]?: ArmValue<M> | readonly ArmValue<M>[];
};

export interface AttrRule<M = unknown> {
  readonly _tag: "AttrRule";
  readonly attr: string;
  readonly rules: RuleSpec<M>;
}

export type NsRuleSpec<M> = RuleSpec<M> & {
  readonly preset?: readonly Preset[];
  readonly attrs?: readonly AttrRule<M>[];
};

export interface PolicyHead<
  C extends AnySchema = AnySchema,
  CF extends Schema.Struct.Fields = Schema.Struct.Fields,
> {
  readonly schema: C;
  /** attribute whose value is the JWT `sub` — derives `me`'s type */
  readonly principal: AttrRef & { readonly ident: CatalogIdent<C> };
  readonly classes: readonly string[];
  /** shape of `ramose.attrs` */
  readonly claims?: Schema.Struct<CF>;
}

export type PolicyArms<C extends AnySchema, M> = {
  readonly [K in keyof C["entities"]]?: NsRuleSpec<M>;
};

interface CompiledArm {
  readonly classes?: readonly string[];
  readonly rule: true | string;
}

interface NsRules {
  readonly prefix: string;
  readonly rules: Readonly<Record<string, readonly CompiledArm[]>>;
  readonly attrs: Readonly<Record<string, Readonly<Record<string, readonly CompiledArm[]>>>>;
  readonly preset: Readonly<Record<string, Operand>>;
}

/** A policy bound to its catalog. `compile` lowers it to the wire JSON. */
export interface Policy<C extends AnySchema = AnySchema> {
  readonly _tag: "Policy";
  readonly schema: C;
  readonly principal: string;
  readonly classes: readonly string[];
  readonly claims?: Schema.Struct<Schema.Struct.Fields>;
  /** catalog namespace key → normalised rules */
  readonly ns: Readonly<Record<string, NsRules>>;
  /** lowered query-engine rule definitions */
  readonly ruleDefs: readonly unknown[];
  /** idents whose attribute rule narrows their namespace's `read` */
  readonly maskedReads: ReadonlySet<string>;
}

const fail = (message: string, ident?: string, cause?: unknown): never => {
  throw new PolicyError({ message: `ramose/policy: ${message}`, ident, cause });
};

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

/** The principal's resolved entity id — a preset operand, not a rule. */
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
  (v as { _tag?: unknown })._tag !== "AttrRule" &&
  (v as { _tag?: unknown })._tag !== "Preset";

/**
 * JWT class gate. `P.class("member")` is a public arm for that class;
 * `P.class("member")(frag)` / `{ class: "member", rule: frag }` compose
 * the gate with a fragment. Checked before the rule runs; never an
 * expression.
 */
export const classFn = (...classes: string[]): ClassFn => {
  if (classes.length === 0) fail("P.class needs at least one class name");
  for (const c of classes) {
    if (typeof c !== "string" || c.length === 0) fail("P.class names must be non-empty strings");
  }
  const apply = ((arm: unknown) => ({
    _tag: "ClassGate" as const,
    classes,
    arm,
  })) as unknown as ClassFn;
  return Object.assign(apply, { _tag: "ClassGate" as const, classes, arm: true as const });
};
export { classFn as class };

/** The peer sets `attr` on `create`. Client-supplied values are `Unauthorized`. */
export const preset = <A extends AttrRef>(attr: A, operand: Operand): Preset => {
  if (operand._tag === "lit") fail(`preset(${identOf(attr)}) takes a claim or the principal`, identOf(attr));
  return { _tag: "Preset", attr: identOf(attr), operand };
};

/** Field rule; narrows (ANDs with) its entity rule. */
export const field = <A extends AttrRef, M>(a: A, rules: RuleSpec<M>): AttrRule<M> => ({
  _tag: "AttrRule",
  attr: identOf(a),
  rules,
});

// ── compile fragments → named rules ────────────────────────────────────────

const catalogIdents = (schema: AnySchema): ReadonlySet<string> => {
  const out = new Set<string>();
  for (const ns of Object.values(schema.entities)) {
    for (const key of Object.keys(ns.fields)) out.add(`:${ns.ns}/${key}`);
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

const isFragFn = (v: unknown): v is FragFn<Var<unknown>> => typeof v === "function" && !isClassGate(v);

const asClassList = (c: string | readonly string[], where: string): readonly string[] => {
  const list = typeof c === "string" ? [c] : [...c];
  if (list.length === 0) fail(`${where}: class gate needs at least one class`);
  return list;
};

const unwrapGate = (
  v: ArmValue<unknown>,
): { readonly classes?: readonly string[]; readonly body: true | FragFn<Var<unknown>> } => {
  if (v === true) return { body: true };
  if (isClassGate(v)) {
    const inner = v.arm === undefined ? true : v.arm;
    if (inner !== true && !isFragFn(inner)) {
      fail("P.class(...) wraps a fragment or true");
    }
    return { classes: v.classes, body: inner as true | FragFn<Var<unknown>> };
  }
  if (isClassConfig(v)) {
    const inner = v.rule === undefined ? true : v.rule;
    if (inner !== true && !isFragFn(inner)) {
      fail("a class gate's rule is a fragment or true");
    }
    return { classes: asClassList(v.class, "class"), body: inner as true | FragFn<Var<unknown>> };
  }
  if (isFragFn(v)) return { body: v };
  return fail("an arm is a fragment, true, or a class gate");
};

const promote = (
  name: string,
  frag: FragFn<Var<unknown>>,
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

const validateRuleBodies = (
  defs: readonly unknown[],
  idents: ReadonlySet<string>,
  where: string,
): void => {
  if (defs.length === 0) return;
  try {
    parseQuery({ find: ["?e"], where: [], rules: defs });
  } catch (cause) {
    fail(
      `${where}: rule body failed query validation: ${cause instanceof Error ? cause.message : String(cause)}`,
      undefined,
      cause,
    );
  }
  walkIdents(defs, (ident) => {
    if (ident.startsWith(":db/")) return;
    if (!idents.has(ident)) fail(`${where}: ${ident} is not in the schema`, ident);
  });
};

// ── authoring ──────────────────────────────────────────────────────────────

/**
 * Build a policy. `policy(head, arms)` is head/body shaped like `Query.q`:
 * `principal: User.sub` derives `me`, and every inline arm is checked as
 * `(me) => fragment` with `me` fully typed. Unknown idents, undeclared
 * classes and unknown namespace keys fail here.
 */
export function policy<
  const C extends AnySchema,
  const I extends CatalogIdent<C>,
  CF extends Schema.Struct.Fields = Schema.Struct.Fields,
>(
  head: {
    readonly schema: C;
    readonly principal: AttrRef & { readonly ident: I };
    readonly classes: readonly string[];
    readonly claims?: Schema.Struct<CF>;
  },
  arms: PolicyArms<C, PrincipalMe<C, I>>,
): Policy<C> {
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

  const classes = [...head.classes];
  if (classes.length === 0) fail("classes must not be empty");
  if (new Set(classes).size !== classes.length) fail("duplicate class");
  const classSet = new Set(classes);

  const checkClasses = (gate: readonly string[] | undefined, where: string): void => {
    if (gate === undefined) return;
    for (const c of gate) {
      if (!classSet.has(c)) fail(`${where}: ${JSON.stringify(c)} is not a declared class`);
    }
  };

  const pending: ReturnType<typeof rule>[] = [];
  const seenFrags = new Map<FragFn<Var<unknown>>, string>();
  let nextRule = 0;

  const compileArm = (raw: ArmValue<unknown>, where: string, prefix: string, op: string): CompiledArm => {
    const { classes: gate, body } = unwrapGate(raw);
    checkClasses(gate, where);
    if (body === true) {
      return gate === undefined ? { rule: true } : { classes: gate, rule: true };
    }
    const existing = seenFrags.get(body);
    const name = existing ?? `policy/${prefix}/${op}/${nextRule++}`;
    if (existing === undefined) {
      pending.push(promote(name, body, where));
      seenFrags.set(body, name);
    }
    return gate === undefined ? { rule: name } : { classes: gate, rule: name };
  };

  const compileSpec = (
    spec: RuleSpec<unknown>,
    where: string,
    prefix: string,
  ): Record<string, readonly CompiledArm[]> => {
    const out: Record<string, CompiledArm[]> = {};
    for (const op of POLICY_OPS) {
      const v = spec[op];
      if (v === undefined) continue;
      const list = Array.isArray(v) ? (v as readonly ArmValue<unknown>[]) : [v as ArmValue<unknown>];
      if (list.length === 0) continue;
      out[op] = list.map((arm, i) => compileArm(arm, `${where}.${op}${list.length > 1 ? `[${i}]` : ""}`, prefix, op));
    }
    return out;
  };

  const ns: Record<string, NsRules> = {};
  const maskedReads = new Set<string>();

  for (const [nsKey, nsSpec] of Object.entries(arms as Record<string, NsRuleSpec<unknown> | undefined>)) {
    if (nsSpec === undefined) continue;
    const declared = (schema.entities as Record<string, { ns: string } | undefined>)[nsKey];
    if (declared === undefined) fail(`ns key ${JSON.stringify(nsKey)} is not in the schema`);
    const prefix = declared!.ns;
    const where = `ns.${nsKey}`;

    const rules = compileSpec(nsSpec, where, prefix);

    const attrs: Record<string, Record<string, readonly CompiledArm[]>> = {};
    for (const a of nsSpec.attrs ?? []) {
      if (a?._tag !== "AttrRule") fail(`${where}.attrs expects P.field(...)`);
      if (!idents.has(a.attr)) fail(`${where}.attrs: ${a.attr} is not in the schema`, a.attr);
      if (!a.attr.startsWith(`:${prefix}/`)) {
        fail(`${where}.attrs: ${a.attr} is not under the ${prefix} namespace`, a.attr);
      }
      const r = compileSpec(a.rules, `${where}.attrs["${a.attr}"]`, `${prefix}/${a.attr.slice(a.attr.lastIndexOf("/") + 1)}`);
      attrs[a.attr] = r;
      if (r.read !== undefined) maskedReads.add(a.attr);
    }

    const presetMap: Record<string, Operand> = {};
    for (const p of nsSpec.preset ?? []) {
      if (p?._tag !== "Preset") fail(`${where}.preset expects P.preset(...)`);
      if (!idents.has(p.attr)) fail(`${where}.preset: ${p.attr} is not in the schema`, p.attr);
      if (!p.attr.startsWith(`:${prefix}/`)) {
        fail(`${where}.preset: ${p.attr} is not under the ${prefix} namespace`, p.attr);
      }
      presetMap[p.attr] = p.operand;
    }

    ns[nsKey] = { prefix, rules, attrs, preset: presetMap };
  }

  const ruleDefs = lowerNamedRules(pending);
  validateRuleBodies(ruleDefs, idents, "rules");

  return {
    _tag: "Policy",
    schema,
    principal: principalIdent,
    classes,
    claims: head.claims as Schema.Struct<Schema.Struct.Fields> | undefined,
    ns,
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
 * Lower to the compiled AST. Namespace rules are emitted once, under `ns`;
 * `attrs` carries only the attributes that narrow their namespace. Core ANDs
 * `attrs[ident][op]` with `ns[prefix][op]` and falls back to whichever side is
 * present (internal/core/policy/eval.ts#allowsOp), so an attribute inherits its
 * namespace without being named and an attribute rule is emitted alone — core
 * supplies the narrowing.
 *
 * Fragment arms compile to named query rules in `rules`; `true` is the empty
 * fragment (public) and does not emit a rule. `RAMOSE_POLICY` is a Cloudflare
 * plain-text binding capped at 5.1 kB, so only written arms and the rules
 * they need are serialised.
 */
const lower = (p: Policy): CompiledPolicy => {
  const attrs: Record<string, AttrRules> = {};
  const ns: Record<string, PolicyRules> = {};
  const preset: Record<string, Operand> = {};

  for (const [nsKey, entry] of Object.entries(p.ns)) {
    const declared = (p.schema.entities as Record<string, { fields: Record<string, unknown> }>)[nsKey]!;
    if (Object.keys(entry.rules).length > 0) ns[entry.prefix] = toWireRules(entry.rules);

    const declaredIdents = new Set(Object.keys(declared.fields).map((key) => `:${entry.prefix}/${key}`));
    for (const [ident, own] of Object.entries(entry.attrs)) {
      if (!declaredIdents.has(ident)) fail(`ns.${nsKey}.attrs: ${ident} is not in the schema`, ident);
      const narrowed = toWireRules(own);
      if (Object.keys(narrowed).length > 0) attrs[ident] = narrowed;
    }
    Object.assign(preset, entry.preset);
  }

  return {
    version: POLICY_VERSION,
    principal: p.principal,
    classes: p.classes,
    claims: claimsJson(p.claims),
    attrs,
    ns,
    preset,
    ...(p.ruleDefs.length > 0 ? { rules: p.ruleDefs } : {}),
  };
};

export interface CompileOptions {
  /** app pull patterns, checked for read-masked attributes used as required */
  readonly pulls?: readonly unknown[];
}

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
  if (options?.pulls) checkPulls(p, options.pulls);
  const compiled = lower(p);
  const json = JSON.stringify(compiled);
  try {
    parsePolicy(JSON.parse(json));
  } catch (cause) {
    fail(`compiled policy failed core validation: ${(cause as Error).message}`, undefined, cause);
  }
  return json;
};
