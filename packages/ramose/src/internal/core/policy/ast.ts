/** The compiled policy AST: plain, versioned JSON. Rules attach to attributes, a namespace entry is the fallback for its prefix, nothing matching = deny. */

export const POLICY_VERSION = 1;
/** Max nesting of `ref` arrows in one expression. */
export const MAX_REF_DEPTH = 3;

export type PolicyOp = "read" | "add" | "retract" | "retractEntity" | "create";
export const POLICY_OPS: readonly PolicyOp[] = ["read", "add", "retract", "retractEntity", "create"];

/** Path into `Principal.claims`, e.g. ["sub"] or ["attrs", "org"]. */
export type ClaimPath = readonly string[];

export type PolicyOperand =
  /** the principal's resolved entity id */
  | { readonly _tag: "principal" }
  | { readonly _tag: "claim"; readonly path: ClaimPath }
  | { readonly _tag: "lit"; readonly value: unknown };

export type PolicyExpr =
  | { readonly _tag: "const"; readonly value: boolean }
  /** folds to a constant per session; reads nothing */
  | { readonly _tag: "class"; readonly class: string }
  /** a datom [e attr operand] exists; on cardinality-many this is membership */
  | { readonly _tag: "eq"; readonly attr: string; readonly operand: PolicyOperand }
  /** follow [e attr ?x] and evaluate `target` at each ?x */
  | { readonly _tag: "ref"; readonly attr: string; readonly target: PolicyExpr }
  | { readonly _tag: "and"; readonly exprs: readonly PolicyExpr[] }
  | { readonly _tag: "or"; readonly exprs: readonly PolicyExpr[] }
  | { readonly _tag: "not"; readonly expr: PolicyExpr };

export interface PolicyArm {
  readonly _tag: "allow" | "deny";
  readonly expr: PolicyExpr;
}

/** Arms per op. Allow arms OR; any true deny wins; no arms → deny. */
export type PolicyRules = { readonly [K in PolicyOp]?: readonly PolicyArm[] };
export type AttrRules = PolicyRules;

export interface CompiledPolicy {
  readonly version: 1;
  /** attribute ident whose value is the JWT `sub`, e.g. ":user/sub" */
  readonly principal: string;
  readonly classes: readonly string[];
  /** shape of `ramose.attrs`; opaque to core (Effect Schema JSON in alchemy) */
  readonly claims?: unknown;
  readonly attrs: Readonly<Record<string, AttrRules>>;
  /** namespace prefix (no leading ':') → fallback rules */
  readonly ns?: Readonly<Record<string, PolicyRules>>;
  /** attribute ident → value the peer injects on create */
  readonly preset: Readonly<Record<string, PolicyOperand>>;
}

// ---------------------------------------------------------------------------
// Constructors (small; alchemy's typed combinators lower to these)
// ---------------------------------------------------------------------------

export const PolicyAst = {
  const: (value: boolean): PolicyExpr => ({ _tag: "const", value }),
  class: (c: string): PolicyExpr => ({ _tag: "class", class: c }),
  eq: (attr: string, operand: PolicyOperand): PolicyExpr => ({ _tag: "eq", attr, operand }),
  ref: (attr: string, target: PolicyExpr): PolicyExpr => ({ _tag: "ref", attr, target }),
  and: (...exprs: PolicyExpr[]): PolicyExpr => ({ _tag: "and", exprs }),
  or: (...exprs: PolicyExpr[]): PolicyExpr => ({ _tag: "or", exprs }),
  not: (expr: PolicyExpr): PolicyExpr => ({ _tag: "not", expr }),
  allow: (expr: PolicyExpr): PolicyArm => ({ _tag: "allow", expr }),
  deny: (expr: PolicyExpr): PolicyArm => ({ _tag: "deny", expr }),
  principal: { _tag: "principal" } as PolicyOperand,
  claim: (...path: string[]): PolicyOperand => ({ _tag: "claim", path }),
  lit: (value: unknown): PolicyOperand => ({ _tag: "lit", value }),
} as const;

/** ":doc/title" → "doc"; undefined when the ident has no namespace. */
export function nsPrefix(ident: string): string | undefined {
  const start = ident[0] === ":" ? 1 : 0;
  const slash = ident.lastIndexOf("/");
  return slash > start ? ident.slice(start, slash) : undefined;
}

// ---------------------------------------------------------------------------
// Runtime validation
// ---------------------------------------------------------------------------

export class PolicyParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyParseError";
  }
}

function fail(path: string, msg: string): never {
  throw new PolicyParseError(`policy${path}: ${msg}`);
}

function obj(x: unknown, path: string): Record<string, unknown> {
  if (typeof x !== "object" || x === null || Array.isArray(x)) fail(path, `expected an object, got ${describe(x)}`);
  return x as Record<string, unknown>;
}

function describe(x: unknown): string {
  if (x === null) return "null";
  if (Array.isArray(x)) return "an array";
  return typeof x;
}

function attrIdent(x: unknown, path: string): string {
  if (typeof x !== "string" || x[0] !== ":") fail(path, `expected an attribute ident like ":user/sub", got ${JSON.stringify(x)}`);
  return x as string;
}

function parseOperand(x: unknown, path: string): PolicyOperand {
  const o = obj(x, path);
  switch (o._tag) {
    case "principal":
      return { _tag: "principal" };
    case "claim": {
      if (!Array.isArray(o.path) || o.path.length === 0 || o.path.some((k) => typeof k !== "string")) {
        fail(path + ".path", "expected a non-empty array of strings");
      }
      return { _tag: "claim", path: (o.path as string[]).slice() };
    }
    case "lit":
      if (!("value" in o)) fail(path, "lit operand needs a `value`");
      return { _tag: "lit", value: o.value };
    default:
      fail(path, `unknown operand _tag ${JSON.stringify(o._tag)} (principal | claim | lit)`);
  }
}

function parseExpr(x: unknown, path: string, classes: ReadonlySet<string>, refDepth: number): PolicyExpr {
  const o = obj(x, path);
  switch (o._tag) {
    case "const":
      if (typeof o.value !== "boolean") fail(path + ".value", "expected a boolean");
      return { _tag: "const", value: o.value };
    case "class": {
      if (typeof o.class !== "string") fail(path + ".class", "expected a string");
      if (!classes.has(o.class)) fail(path + ".class", `${JSON.stringify(o.class)} is not a declared class`);
      return { _tag: "class", class: o.class };
    }
    case "eq":
      return { _tag: "eq", attr: attrIdent(o.attr, path + ".attr"), operand: parseOperand(o.operand, path + ".operand") };
    case "ref": {
      if (refDepth + 1 > MAX_REF_DEPTH) fail(path, `ref nesting exceeds depth ${MAX_REF_DEPTH}`);
      return {
        _tag: "ref",
        attr: attrIdent(o.attr, path + ".attr"),
        target: parseExpr(o.target, path + ".target", classes, refDepth + 1),
      };
    }
    case "and":
    case "or": {
      if (!Array.isArray(o.exprs) || o.exprs.length === 0) fail(path + ".exprs", "expected a non-empty array");
      const exprs = (o.exprs as unknown[]).map((e, i) => parseExpr(e, `${path}.exprs[${i}]`, classes, refDepth));
      return o._tag === "and" ? { _tag: "and", exprs } : { _tag: "or", exprs };
    }
    case "not":
      return { _tag: "not", expr: parseExpr(o.expr, path + ".expr", classes, refDepth) };
    default:
      fail(path, `unknown expr _tag ${JSON.stringify(o._tag)}`);
  }
}

function parseRules(x: unknown, path: string, classes: ReadonlySet<string>): PolicyRules {
  const o = obj(x, path);
  const out: Record<string, PolicyArm[]> = {};
  for (const [op, arms] of Object.entries(o)) {
    if (!(POLICY_OPS as readonly string[]).includes(op)) {
      fail(`${path}.${op}`, `unknown op (${POLICY_OPS.join(" | ")})`);
    }
    if (!Array.isArray(arms)) fail(`${path}.${op}`, "expected an array of arms");
    out[op] = (arms as unknown[]).map((arm, i) => {
      const a = obj(arm, `${path}.${op}[${i}]`);
      if (a._tag !== "allow" && a._tag !== "deny") {
        fail(`${path}.${op}[${i}]._tag`, `expected "allow" or "deny", got ${JSON.stringify(a._tag)}`);
      }
      return { _tag: a._tag as "allow" | "deny", expr: parseExpr(a.expr, `${path}.${op}[${i}].expr`, classes, 0) };
    });
  }
  return out as PolicyRules;
}

/** Decode + validate a compiled policy. Throws `PolicyParseError` when bad. */
export function parsePolicy(json: unknown): CompiledPolicy {
  const o = obj(json, "");
  if (o.version !== POLICY_VERSION) {
    fail(".version", `expected ${POLICY_VERSION}, got ${JSON.stringify(o.version)}`);
  }
  const principal = attrIdent(o.principal, ".principal");
  if (!Array.isArray(o.classes) || o.classes.length === 0 || o.classes.some((c) => typeof c !== "string")) {
    fail(".classes", "expected a non-empty array of strings");
  }
  const classes = (o.classes as string[]).slice();
  if (new Set(classes).size !== classes.length) fail(".classes", "duplicate class");
  const classSet = new Set(classes);

  const attrsIn = obj(o.attrs ?? {}, ".attrs");
  const attrs: Record<string, AttrRules> = {};
  for (const [ident, rules] of Object.entries(attrsIn)) {
    attrs[attrIdent(ident, `.attrs["${ident}"]`)] = parseRules(rules, `.attrs["${ident}"]`, classSet);
  }

  let ns: Record<string, PolicyRules> | undefined;
  if (o.ns !== undefined && o.ns !== null) {
    ns = {};
    for (const [prefix, rules] of Object.entries(obj(o.ns, ".ns"))) {
      if (prefix.length === 0 || prefix.includes(":") || prefix.includes("/")) {
        fail(`.ns["${prefix}"]`, "expected a bare namespace prefix like \"doc\"");
      }
      ns[prefix] = parseRules(rules, `.ns["${prefix}"]`, classSet);
    }
  }

  const preset: Record<string, PolicyOperand> = {};
  for (const [ident, value] of Object.entries(obj(o.preset ?? {}, ".preset"))) {
    const path = `.preset["${ident}"]`;
    attrIdent(ident, path);
    // shorthand: a bare claim path
    preset[ident] = Array.isArray(value)
      ? parseOperand({ _tag: "claim", path: value }, path)
      : parseOperand(value, path);
  }

  return { version: POLICY_VERSION, principal, classes, claims: o.claims, attrs, ns, preset };
}
