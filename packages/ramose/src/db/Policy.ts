/**
 * Typed policy authoring. Combinators over catalog attributes and JWT claims
 * lower to the engine's compiled AST; every check is deploy-time.
 */

import * as Schema from "effect/Schema";
import {
  MAX_REF_DEPTH,
  POLICY_OPS,
  POLICY_VERSION,
  PolicyAst,
  parsePolicy,
} from "../internal/core/policy/ast.ts";
import type {
  AttrRules,
  CompiledPolicy,
  PolicyArm,
  PolicyExpr,
  PolicyOp,
  PolicyOperand,
  PolicyRules,
} from "../internal/core/policy/ast.ts";
import type { AnyAttribute, ValueOf } from "./Attribute.ts";
import { isAttrRef } from "./attrRef.ts";
import type { AnyCatalog } from "./Catalog.ts";
import { PolicyError } from "./SchemaErrors.ts";
import type { CatalogIdent } from "./idents.ts";
import { inspectPullField } from "./Pull.ts";

// ── shapes ─────────────────────────────────────────────────────────────────

export type Operand = PolicyOperand;
export type Expr = PolicyExpr;
export type Arm = PolicyArm;
export type Op = PolicyOp;

/** A stamped attribute (`User.sub`) — anything carrying `ident` + attr shape. */
export type AttrRef = AnyAttribute & { readonly ident: string };
export type RefAttrRef = AttrRef & { readonly valueType: ":db.type/ref" };

export interface Preset {
  readonly _tag: "Preset";
  readonly attr: string;
  readonly operand: Operand;
}

/** Arms per op; a single arm is shorthand for a one-element array. */
export type RuleSpec = {
  readonly [K in Op]?: Arm | readonly Arm[];
};

export interface AttrRule {
  readonly _tag: "AttrRule";
  readonly attr: string;
  readonly rules: RuleSpec;
}

export type NsRuleSpec = RuleSpec & {
  readonly preset?: readonly Preset[];
  readonly attrs?: readonly AttrRule[];
};

export interface PolicySpec<
  C extends AnyCatalog,
  CF extends Schema.Struct.Fields = Schema.Struct.Fields,
> {
  /** attribute whose value is the JWT `sub` */
  readonly principal: AttrRef & { readonly ident: CatalogIdent<C> };
  readonly classes: readonly string[];
  /** shape of `ramose.attrs` */
  readonly claims?: Schema.Struct<CF>;
  readonly ns: { readonly [K in keyof C["namespaces"]]?: NsRuleSpec };
}

interface NsRules {
  readonly prefix: string;
  readonly rules: PolicyRules;
  readonly attrs: Readonly<Record<string, AttrRules>>;
  readonly preset: Readonly<Record<string, Operand>>;
}

/** A policy bound to its catalog. `compile` lowers it to the wire JSON. */
export interface Policy<C extends AnyCatalog = AnyCatalog> {
  readonly _tag: "Policy";
  readonly catalog: C;
  readonly principal: string;
  readonly classes: readonly string[];
  readonly claims?: Schema.Struct<Schema.Struct.Fields>;
  /** catalog namespace key → normalised rules */
  readonly ns: Readonly<Record<string, NsRules>>;
  /** idents whose attribute rule narrows their namespace's `read` */
  readonly maskedReads: ReadonlySet<string>;
}

const fail = (message: string, ident?: string, cause?: unknown): never => {
  throw new PolicyError({ message: `ramose/policy: ${message}`, ident, cause });
};

// ── claims ─────────────────────────────────────────────────────────────────

/**
 * The JWT Ramose verifies. `ramose.attrs` is decoded by the policy's own
 * `claims` struct; here it stays open.
 */
export const Claims = Schema.Struct({
  iss: Schema.String,
  sub: Schema.String,
  aud: Schema.String,
  exp: Schema.Number,
  iat: Schema.optional(Schema.Number),
  ramose: Schema.Struct({
    db: Schema.String,
    class: Schema.String,
    attrs: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  }),
});
export type Claims = Schema.Schema.Type<typeof Claims>;

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

/** `P.claims.sub`, `P.claims.attrs.org`. */
export const claims: ClaimAccess<Record<string, ClaimOperand>> = claimAccess();

/** Same accessor with `attrs` keyed by a claims struct: `P.claimsOf(S).attrs.org`. */
export const claimsOf = <CF extends Schema.Struct.Fields>(
  _struct: Schema.Struct<CF>,
): ClaimAccess<{ readonly [K in keyof CF & string]: ClaimOperand }> =>
  claimAccess<{ readonly [K in keyof CF & string]: ClaimOperand }>();

/** The principal's resolved entity id. */
export const principal: Operand = PolicyAst.principal;

/** An explicit literal operand; `eq` wraps bare values in this for you. */
export const lit = (value: unknown): Operand => PolicyAst.lit(value);

const isOperand = (v: unknown): v is Operand =>
  typeof v === "object" &&
  v !== null &&
  ((v as { _tag?: unknown })._tag === "principal" ||
    (v as { _tag?: unknown })._tag === "claim" ||
    (v as { _tag?: unknown })._tag === "lit");

// ── expressions ────────────────────────────────────────────────────────────

const identOf = (a: AttrRef): string => {
  if (!isAttrRef(a)) fail(`expected an attribute ref, got ${String(a)}`);
  return a.ident;
};

/** A datom `[e attr v]` exists; on a cardinality-many attribute, membership. */
export const eq = <A extends AttrRef>(attr: A, value: Operand | ValueOf<A>): Expr =>
  PolicyAst.eq(identOf(attr), isOperand(value) ? value : PolicyAst.lit(value));

const refDepthOf = (e: Expr): number => {
  switch (e._tag) {
    case "ref":
      return 1 + refDepthOf(e.target);
    case "and":
    case "or":
      return e.exprs.reduce((m, x) => Math.max(m, refDepthOf(x)), 0);
    case "not":
      return refDepthOf(e.expr);
    default:
      return 0;
  }
};

const isExpr = (v: unknown): v is Expr =>
  typeof v === "object" && v !== null && typeof (v as { _tag?: unknown })._tag === "string" && !isAttrRef(v);

/**
 * Follow `[e attr ?x]` and evaluate `target` at each `?x`. A bare attribute
 * target means "contains the principal". Depth ≤ `MAX_REF_DEPTH`.
 */
export const ref = (attr: RefAttrRef, target: Expr | AttrRef): Expr => {
  const ident = identOf(attr);
  if (attr.valueType !== undefined && attr.valueType !== ":db.type/ref") {
    fail(`ref() needs a :db.type/ref attribute; ${ident} is ${attr.valueType}`, ident);
  }
  const inner = isExpr(target) ? target : eq(target as AttrRef, principal);
  const expr = PolicyAst.ref(ident, inner);
  if (refDepthOf(expr) > MAX_REF_DEPTH) {
    fail(`ref nesting exceeds depth ${MAX_REF_DEPTH}`, ident);
  }
  return expr;
};

/** `c === ramose.class`. Validated against the policy's `classes` at `policy()`. */
const classExpr = (c: string): Expr => PolicyAst.class(c);
export { classExpr as class };

export const and = (...exprs: readonly Expr[]): Expr => PolicyAst.and(...exprs);
export const or = (...exprs: readonly Expr[]): Expr => PolicyAst.or(...exprs);
export const not = (expr: Expr): Expr => PolicyAst.not(expr);
export const constant = (value: boolean): Expr => PolicyAst.const(value);

export const allow = (expr: Expr): Arm => PolicyAst.allow(expr);
export const deny = (expr: Expr): Arm => PolicyAst.deny(expr);

/** The peer sets `attr` on `create`. Client-supplied values are `Unauthorized`. */
export const preset = <A extends AttrRef>(attr: A, operand: Operand): Preset => {
  if (operand._tag === "lit") fail(`preset(${identOf(attr)}) takes a claim or the principal`, identOf(attr));
  return { _tag: "Preset", attr: identOf(attr), operand };
};

/** Attribute rule; narrows (ANDs with) its namespace rule. */
export const attr = <A extends AttrRef>(a: A, rules: RuleSpec): AttrRule => ({
  _tag: "AttrRule",
  attr: identOf(a),
  rules,
});

// ── lowering ───────────────────────────────────────────────────────────────

const armsOf = (v: Arm | readonly Arm[] | undefined): readonly Arm[] | undefined => {
  if (v === undefined) return undefined;
  const arms = Array.isArray(v) ? (v as readonly Arm[]) : [v as Arm];
  return arms.length === 0 ? undefined : arms;
};

const rulesOf = (spec: RuleSpec, where: string): PolicyRules => {
  const out: Record<string, readonly Arm[]> = {};
  for (const op of POLICY_OPS) {
    const arms = armsOf(spec[op]);
    if (arms) {
      for (const arm of arms) {
        if (arm?._tag !== "allow" && arm?._tag !== "deny") {
          fail(`${where}.${op} expects P.allow(...) / P.deny(...)`);
        }
      }
      out[op] = arms;
    }
  }
  return out as PolicyRules;
};

const catalogIdents = (catalog: AnyCatalog): ReadonlySet<string> => {
  const out = new Set<string>();
  for (const ns of Object.values(catalog.namespaces)) {
    for (const key of Object.keys(ns.attributes)) out.add(`:${ns.ns}/${key}`);
  }
  return out;
};

const walkExpr = (
  e: Expr,
  visit: (attrIdent: string) => void,
  visitClass: (c: string) => void,
): void => {
  switch (e._tag) {
    case "eq":
      visit(e.attr);
      return;
    case "ref":
      visit(e.attr);
      walkExpr(e.target, visit, visitClass);
      return;
    case "and":
    case "or":
      for (const x of e.exprs) walkExpr(x, visit, visitClass);
      return;
    case "not":
      walkExpr(e.expr, visit, visitClass);
      return;
    case "class":
      visitClass(e.class);
      return;
    default:
  }
};

/**
 * Build a policy against its catalog. Unknown idents, undeclared classes,
 * unknown namespace keys and over-deep refs all fail here.
 */
export const policy = <
  const C extends AnyCatalog,
  CF extends Schema.Struct.Fields = Schema.Struct.Fields,
>(
  catalog: C,
  spec: PolicySpec<C, CF>,
): Policy<C> => {
  const idents = catalogIdents(catalog);
  const principalIdent = identOf(spec.principal as AttrRef);
  if (!idents.has(principalIdent)) fail(`principal ${principalIdent} is not in the catalog`, principalIdent);

  const classes = [...spec.classes];
  if (classes.length === 0) fail("classes must not be empty");
  if (new Set(classes).size !== classes.length) fail("duplicate class");
  const classSet = new Set(classes);

  const checkExpr = (e: Expr, where: string): void => {
    if (refDepthOf(e) > MAX_REF_DEPTH) fail(`${where}: ref nesting exceeds depth ${MAX_REF_DEPTH}`);
    walkExpr(
      e,
      (a) => {
        if (!idents.has(a)) fail(`${where}: ${a} is not in the catalog`, a);
      },
      (c) => {
        if (!classSet.has(c)) fail(`${where}: ${JSON.stringify(c)} is not a declared class`);
      },
    );
  };

  const checkRules = (rules: PolicyRules, where: string): void => {
    for (const op of POLICY_OPS) {
      for (const arm of rules[op] ?? []) checkExpr(arm.expr, `${where}.${op}`);
    }
  };

  const ns: Record<string, NsRules> = {};
  const maskedReads = new Set<string>();

  for (const [nsKey, nsSpec] of Object.entries(spec.ns as Record<string, NsRuleSpec | undefined>)) {
    if (nsSpec === undefined) continue;
    const declared = (catalog.namespaces as Record<string, { ns: string } | undefined>)[nsKey];
    if (declared === undefined) fail(`ns key ${JSON.stringify(nsKey)} is not in the catalog`);
    const prefix = declared!.ns;
    const where = `ns.${nsKey}`;

    const rules = rulesOf(nsSpec, where);
    checkRules(rules, where);

    const attrs: Record<string, AttrRules> = {};
    for (const rule of nsSpec.attrs ?? []) {
      if (rule?._tag !== "AttrRule") fail(`${where}.attrs expects P.attr(...)`);
      if (!idents.has(rule.attr)) fail(`${where}.attrs: ${rule.attr} is not in the catalog`, rule.attr);
      if (!rule.attr.startsWith(`:${prefix}/`)) {
        fail(`${where}.attrs: ${rule.attr} is not under the ${prefix} namespace`, rule.attr);
      }
      const r = rulesOf(rule.rules, `${where}.attrs["${rule.attr}"]`);
      checkRules(r, `${where}.attrs["${rule.attr}"]`);
      attrs[rule.attr] = { ...attrs[rule.attr], ...r };
      if (r.read !== undefined) maskedReads.add(rule.attr);
    }

    const preset: Record<string, Operand> = {};
    for (const p of nsSpec.preset ?? []) {
      if (p?._tag !== "Preset") fail(`${where}.preset expects P.preset(...)`);
      if (!idents.has(p.attr)) fail(`${where}.preset: ${p.attr} is not in the catalog`, p.attr);
      if (!p.attr.startsWith(`:${prefix}/`)) {
        fail(`${where}.preset: ${p.attr} is not under the ${prefix} namespace`, p.attr);
      }
      preset[p.attr] = p.operand;
    }

    ns[nsKey] = { prefix, rules, attrs, preset };
  }

  return {
    _tag: "Policy",
    catalog,
    principal: principalIdent,
    classes,
    claims: spec.claims as Schema.Struct<Schema.Struct.Fields> | undefined,
    ns,
    maskedReads,
  };
};

const claimsJson = (struct: Schema.Struct<Schema.Struct.Fields> | undefined): unknown => {
  if (struct === undefined) return undefined;
  try {
    return Schema.toJsonSchemaDocument(struct);
  } catch {
    return { keys: Object.keys(struct.fields) };
  }
};

/**
 * Lower to the compiled AST. Namespace rules are materialised onto every
 * attribute the catalog declares under that prefix *and* kept under `ns`, so
 * an attribute added later still inherits them. Core ANDs `attrs[ident][op]`
 * with `ns[prefix][op]`, so a materialised op is the identical arm list on
 * both sides (AND is idempotent) and an attribute rule is emitted alone —
 * core supplies the narrowing.
 */
const lower = (p: Policy): CompiledPolicy => {
  const attrs: Record<string, AttrRules> = {};
  const ns: Record<string, PolicyRules> = {};
  const preset: Record<string, Operand> = {};

  for (const [nsKey, entry] of Object.entries(p.ns)) {
    const declared = (p.catalog.namespaces as Record<string, { attributes: Record<string, unknown> }>)[nsKey]!;
    if (Object.keys(entry.rules).length > 0) ns[entry.prefix] = entry.rules;

    for (const key of Object.keys(declared.attributes)) {
      const ident = `:${entry.prefix}/${key}`;
      const own = entry.attrs[ident];
      const merged: Record<string, readonly Arm[]> = {};
      for (const op of POLICY_OPS) {
        const arms = own?.[op] ?? entry.rules[op];
        if (arms) merged[op] = arms;
      }
      if (Object.keys(merged).length > 0) attrs[ident] = merged as AttrRules;
    }
    // an attribute rule on an ident the catalog no longer declares is a bug
    for (const ident of Object.keys(entry.attrs)) {
      if (attrs[ident] === undefined) fail(`ns.${nsKey}.attrs: ${ident} is not in the catalog`, ident);
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
    if (pattern === null || typeof pattern !== "object" || Array.isArray(pattern)) return;
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
  if (p?._tag !== "Policy") fail("compile() expects a P.policy(...) value");
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
