/**
 * Deterministic validation, resolution, normalization, and budget
 * accounting for `QueryDocumentV1`.
 *
 * Nothing here reads a clock, a random source, or the environment: the
 * same document, catalog, registry, and limits always produce the same
 * normalized document, the same resolved plan, the same complexity, and
 * the same first issue. Validation runs in canonical document order and
 * reports the first issue it reaches, so two peers agree on *which*
 * problem a bad document has.
 *
 * Resolution happens exactly once, here. Lowering consumes the resolved
 * tree and never looks a name up again.
 */

import { fromJson } from "../../../internal/core/json.ts";
import type { AnyComposer } from "../../Composer.ts";
import type { QueryCatalogV1 } from "./catalog.ts";
import type { FieldRefV1, FunctionDefinitionV1, FunctionRegistryV1 } from "./registry.ts";
import {
  DEFAULT_QUERY_LIMITS,
  EXPRESSION_TAGS,
  QUERY_DOCUMENT_VERSION,
  type BindingV1,
  type CardinalityV1,
  type ExpressionContextV1,
  type ExpressionTag,
  type ExpressionV1,
  type NormalizedOrderV1,
  type NormalizedQueryDocumentV1,
  type ProjectionV1,
  type QueryComplexityV1,
  type QueryDocumentIssueCode,
  type QueryDocumentIssueV1,
  type QueryDocumentPath,
  type QueryJsonValue,
  type QueryLimitsV1,
  type QueryRootV1,
  type ValueTypeV1,
} from "./types.ts";

// ── the resolved tree ───────────────────────────────────────────────────────

/** One hop of a resolved field path: the owner it leaves, and the field. */
export interface FieldStepV1 {
  readonly owner: AnyComposer;
  readonly field: FieldRefV1;
}

export type ResolvedExprV1 =
  | {
      readonly kind: "field";
      readonly steps: readonly FieldStepV1[];
      readonly type: ValueTypeV1;
      readonly many: boolean;
      readonly optional: boolean;
    }
  | { readonly kind: "constant"; readonly value: unknown; readonly type: ValueTypeV1 }
  | { readonly kind: "var"; readonly name: string; readonly type: ValueTypeV1 }
  | {
      readonly kind: "call";
      readonly def: FunctionDefinitionV1;
      readonly args: readonly ResolvedExprV1[];
      readonly type: ValueTypeV1;
      readonly predicate: boolean;
    };

export interface ResolvedBindingV1 {
  readonly name: string;
  readonly expr: ResolvedExprV1;
}

export type ResolvedSelectionV1 =
  | { readonly kind: "expr"; readonly key: string; readonly expr: ResolvedExprV1 }
  | {
      readonly kind: "nested";
      readonly key: string;
      readonly step: FieldStepV1;
      readonly target: AnyComposer;
      readonly select: readonly ResolvedSelectionV1[];
    };

export interface ResolvedOrderV1 {
  readonly key:
    | { readonly kind: "field"; readonly steps: readonly FieldStepV1[] }
    | { readonly kind: "var"; readonly name: string };
  readonly direction: "asc" | "desc";
  readonly empty: "first" | "last";
}

export interface ResolvedQueryDocumentV1 {
  readonly root: AnyComposer;
  readonly bindings: readonly ResolvedBindingV1[];
  readonly where: ResolvedExprV1 | null;
  /** `null` is the default full-entity row. */
  readonly select: readonly ResolvedSelectionV1[] | null;
  readonly orderBy: readonly ResolvedOrderV1[];
  readonly page: { readonly first: number | null; readonly after: string | null; readonly offset: number | null };
  readonly cardinality: CardinalityV1;
}

export interface ValidatedQueryDocumentV1 {
  readonly document: NormalizedQueryDocumentV1;
  readonly resolved: ResolvedQueryDocumentV1;
  readonly complexity: QueryComplexityV1;
}

export interface ValidateOptionsV1 {
  readonly catalog: QueryCatalogV1;
  readonly registry: FunctionRegistryV1;
  readonly limits?: QueryLimitsV1;
}

// ── issue plumbing ──────────────────────────────────────────────────────────

/** Thrown internally, caught at the boundary — never escapes this module. */
class Issue extends Error {
  readonly issue: QueryDocumentIssueV1;
  constructor(issue: QueryDocumentIssueV1) {
    super(issue.message);
    this.issue = issue;
  }
}

const raise = (
  code: QueryDocumentIssueCode,
  path: QueryDocumentPath,
  message: string,
): never => {
  throw new Issue({ code, path, message });
};

const malformed = (path: QueryDocumentPath, message: string): never =>
  raise("malformed", path, message);

/** One code for "no such definition" and "not visible" — see `catalog.ts`. */
const unknownDefinition = (path: QueryDocumentPath, what: string, name: string): never =>
  raise("unknown_definition", path, `unknown ${what} "${name}"`);

// ── plain-data guards ───────────────────────────────────────────────────────

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const isPlainObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

/**
 * Read one optional member. `null` reads as absent so a normalized
 * document — which writes every default explicitly, `null` included —
 * validates back to itself.
 */
const member = (raw: Record<string, unknown>, key: string): unknown => {
  const value = raw[key];
  return value === null ? undefined : value;
};

const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const assertName = (value: unknown, path: QueryDocumentPath, what: string): string => {
  if (typeof value !== "string" || !NAME.test(value)) {
    return malformed(path, `${what} is an identifier ([A-Za-z_][A-Za-z0-9_]*)`) as never;
  }
  return value;
};

const assertKey = (key: string, path: QueryDocumentPath): string => {
  if (RESERVED_KEYS.has(key)) return malformed(path, `"${key}" is not a usable key`) as never;
  if (!NAME.test(key)) {
    return malformed(path, `projection keys are identifiers, got "${key}"`) as never;
  }
  return key;
};

/**
 * The typed-value tags a document may write. These are Ramose's existing
 * canonical JSON encoding for values JSON cannot carry natively — the same
 * `{ $inst } / { $bytes } / { $uuid }` form the HTTP API, the DO RPC
 * bodies, and `Query.encodeCursor` already round-trip through
 * `internal/core/json.ts`. A document does not invent a second encoding.
 */
const VALUE_TAGS: Readonly<Record<string, ValueTypeV1>> = {
  $inst: "instant",
  $bytes: "bytes",
  $uuid: "uuid",
};

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Validate and canonicalize one tagged value. One tag, one canonical form. */
const assertTagged = (
  tag: string,
  payload: unknown,
  path: QueryDocumentPath,
): QueryJsonValue => {
  if (tag === "$inst") {
    // Epoch milliseconds is the canonical form; an ISO string is accepted
    // and normalized to it, so one instant has one serialization.
    if (typeof payload === "number" && Number.isInteger(payload)) return { $inst: payload };
    if (typeof payload === "string") {
      const ms = Date.parse(payload);
      if (!Number.isNaN(ms)) return { $inst: ms };
    }
    return malformed(path, "$inst is epoch milliseconds or an ISO-8601 string") as never;
  }
  if (tag === "$uuid") {
    if (typeof payload !== "string" || !UUID.test(payload)) {
      return malformed(path, "$uuid is a canonical UUID string") as never;
    }
    return { $uuid: payload.toLowerCase() };
  }
  if (typeof payload !== "string" || payload.length % 4 !== 0 || !BASE64.test(payload)) {
    return malformed(path, "$bytes is a base64 string") as never;
  }
  return { $bytes: payload };
};

/**
 * Depth-bounded JSON check: no `undefined`, functions, NaN, or exotic
 * objects, plus the typed-value tags above.
 *
 * Every other `$`-prefixed key is refused. That reservation is what keeps
 * a future tagged encoding *additive*: a document accepted today can never
 * be reinterpreted tomorrow, because no document carrying an unrecognized
 * `$` tag was ever accepted.
 */
const assertJson = (value: unknown, path: QueryDocumentPath, depth = 0): QueryJsonValue => {
  if (depth > 16) return malformed(path, "value nests deeper than the document allows") as never;
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value as QueryJsonValue;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return malformed(path, "a value is a finite JSON number") as never;
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((v, i) => assertJson(v, [...path, i], depth + 1)) as QueryJsonValue;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && Object.hasOwn(VALUE_TAGS, keys[0]!)) {
      return assertTagged(keys[0]!, value[keys[0]!], path);
    }
    const out: Record<string, QueryJsonValue> = {};
    for (const key of keys.sort()) {
      if (RESERVED_KEYS.has(key)) return malformed([...path, key], `"${key}" is not a usable key`) as never;
      if (key.startsWith("$")) {
        return malformed(
          [...path, key],
          `the "$" prefix is reserved for typed value encodings (${Object.keys(VALUE_TAGS).join(", ")})`,
        ) as never;
      }
      out[key] = assertJson(value[key], [...path, key], depth + 1);
    }
    return out;
  }
  return malformed(path, "a value is plain JSON") as never;
};

/** The declared type of a canonical literal — read off its tag, not its
 * decoded JavaScript shape (a UUID decodes to a string). */
const constantType = (value: QueryJsonValue): ValueTypeV1 => {
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (value === null) return "any";
  if (!Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && Object.hasOwn(VALUE_TAGS, keys[0]!)) return VALUE_TAGS[keys[0]!]!;
  }
  return "json";
};

/** The engine-ready value a canonical literal denotes: `{ $inst }` is a
 * `Date`, `{ $bytes }` a `Uint8Array`, `{ $uuid }` the canonical string. */
const constantValue = (value: QueryJsonValue): unknown => fromJson(value);

const assignable = (actual: ValueTypeV1, expected: ValueTypeV1): boolean =>
  expected === "any" ||
  actual === "any" ||
  expected === "json" ||
  actual === expected ||
  // an entity id is a number on the wire; the public document never sees
  // any other spelling of one
  (expected === "ref" && actual === "number");

// ── expression resolution ───────────────────────────────────────────────────

interface Scope {
  readonly catalog: QueryCatalogV1;
  readonly registry: FunctionRegistryV1;
  readonly root: AnyComposer;
  readonly params: ReadonlyMap<string, QueryJsonValue>;
  readonly vars: ReadonlyMap<string, ValueTypeV1>;
}

/** Which tag an expression node carries — exactly one, or it is malformed. */
const expressionTag = (node: unknown, path: QueryDocumentPath): ExpressionTag => {
  if (!isPlainObject(node)) {
    return malformed(path, "an expression is an object with exactly one tag") as never;
  }
  const keys = Object.keys(node);
  const tags = EXPRESSION_TAGS.filter((t) => keys.includes(t));
  if (tags.length !== 1) {
    return malformed(
      path,
      tags.length === 0
        ? `an expression tag is one of ${EXPRESSION_TAGS.join(", ")}`
        : `an expression carries exactly one tag, got ${tags.join(" and ")}`,
    ) as never;
  }
  const tag = tags[0]!;
  const allowed = tag === "call" ? ["call", "args"] : [tag];
  const extra = keys.filter((k) => !allowed.includes(k));
  if (extra.length > 0) {
    return malformed(path, `a { ${tag} } node has no member "${extra[0]}"`) as never;
  }
  return tag;
};

/** Walk a field path from the root, resolving every hop through the catalog. */
const resolveFieldPath = (
  scope: Scope,
  raw: unknown,
  path: QueryDocumentPath,
): readonly FieldStepV1[] => {
  if (!Array.isArray(raw) || raw.length === 0) {
    return malformed(path, "a field path is a non-empty array of field names") as never;
  }
  const steps: FieldStepV1[] = [];
  let owner: AnyComposer = scope.root;
  for (let i = 0; i < raw.length; i++) {
    const segment = raw[i];
    if (typeof segment !== "string" || segment.length === 0) {
      return malformed([...path, i], "a field path segment is a non-empty string") as never;
    }
    const field = scope.catalog.field(owner, segment);
    if (field === undefined) unknownDefinition([...path, i], "field", segment);
    steps.push({ owner, field: field! });
    if (i === raw.length - 1) break;
    if (field!.type !== "ref") {
      return malformed(
        [...path, i],
        `"${segment}" is not a reference — only a reference continues a field path`,
      ) as never;
    }
    const target = scope.catalog.target(owner, field!);
    if (target === undefined) unknownDefinition([...path, i], "reference target", segment);
    owner = target!;
  }
  return steps;
};

const fieldExpr = (steps: readonly FieldStepV1[]): ResolvedExprV1 => {
  const leaf = steps[steps.length - 1]!.field;
  return {
    kind: "field",
    steps,
    type: leaf.type,
    many: steps.some((s) => s.field.many),
    optional: leaf.optional,
  };
};

/**
 * Resolve one expression in one context. `predicatePosition` is true where
 * a boolean *constraint* is expected rather than a boolean value — the
 * `where` root, and every `boolean` parameter of a predicate function.
 */
const resolveExpr = (
  scope: Scope,
  node: unknown,
  path: QueryDocumentPath,
  context: ExpressionContextV1,
  predicatePosition: boolean,
  depth: number,
): ResolvedExprV1 => {
  if (depth > 32) return malformed(path, "expression nests deeper than the document allows") as never;
  const tag = expressionTag(node, path);
  const obj = node as Record<string, unknown>;
  switch (tag) {
    case "field": {
      const steps = resolveFieldPath(scope, obj["field"], [...path, "field"]);
      return fieldExpr(steps);
    }
    case "value": {
      const value = assertJson(obj["value"], [...path, "value"]);
      return { kind: "constant", value: constantValue(value), type: constantType(value) };
    }
    case "param": {
      const name = assertName(obj["param"], [...path, "param"], "a parameter name");
      if (!scope.params.has(name)) {
        malformed([...path, "param"], `no parameter "${name}" is declared`);
      }
      const value = scope.params.get(name)!;
      return { kind: "constant", value: constantValue(value), type: constantType(value) };
    }
    case "var": {
      const name = assertName(obj["var"], [...path, "var"], "a binding name");
      const type = scope.vars.get(name);
      if (type === undefined) {
        malformed([...path, "var"], `no binding "${name}" is in scope here`);
      }
      return { kind: "var", name, type: type! };
    }
    case "call": {
      const name = obj["call"];
      if (typeof name !== "string" || name.length === 0) {
        return malformed([...path, "call"], "a call names a function") as never;
      }
      const def = scope.registry.lookup(name);
      if (def === undefined) unknownDefinition([...path, "call"], "query function", name);
      const definition = def!;
      const rawArgs = obj["args"];
      if (!Array.isArray(rawArgs)) {
        return malformed([...path, "args"], "a call carries an args array") as never;
      }
      const isPredicate = definition.lower.kind === "predicate";
      if (isPredicate && !predicatePosition) {
        return malformed(
          path,
          `"${name}" filters rows and binds no value — it belongs in a filter position`,
        ) as never;
      }
      if (!definition.signature.contexts.includes(context)) {
        return malformed(
          path,
          `"${name}" is not available in ${context}`,
        ) as never;
      }
      const params = definition.signature.params;
      const rest = params.length > 0 && params[params.length - 1]!.rest === true;
      const min = rest ? params.length - 1 : params.length;
      if (rawArgs.length < min || (!rest && rawArgs.length !== params.length)) {
        return malformed(
          [...path, "args"],
          `"${name}" takes ${rest ? `at least ${min}` : String(params.length)} argument${
            (rest ? min : params.length) === 1 ? "" : "s"
          }, got ${rawArgs.length}`,
        ) as never;
      }
      const args = rawArgs.map((arg, i) => {
        const param = i < min ? params[i]! : params[params.length - 1]!;
        const nested = isPredicate && param.type === "boolean";
        const resolved = resolveExpr(
          scope,
          arg,
          [...path, "args", i],
          context,
          nested,
          depth + 1,
        );
        const argIsPredicate = resolved.kind === "call" && resolved.predicate;
        if (!argIsPredicate && !assignable(resolved.type, param.type)) {
          malformed(
            [...path, "args", i],
            `"${name}" takes ${param.type} for "${param.name}", got ${resolved.type}`,
          );
        }
        return resolved;
      });
      return {
        kind: "call",
        def: definition,
        args,
        type: definition.signature.result,
        predicate: isPredicate,
      };
    }
  }
};

// ── member validation ───────────────────────────────────────────────────────

const validateRoot = (raw: unknown, catalog: QueryCatalogV1): {
  readonly root: QueryRootV1;
  readonly composer: AnyComposer;
} => {
  const path: QueryDocumentPath = ["from"];
  if (!isPlainObject(raw)) return malformed(path, "from is { entity } or { trait }") as never;
  const keys = Object.keys(raw);
  const tags = keys.filter((k) => k === "entity" || k === "trait");
  if (keys.length !== 1 || tags.length !== 1) {
    return malformed(path, "from carries exactly one of entity, trait") as never;
  }
  const tag = tags[0] as "entity" | "trait";
  const name = raw[tag];
  if (typeof name !== "string" || name.length === 0) {
    return malformed([...path, tag], `a ${tag} name is a non-empty string`) as never;
  }
  const root: QueryRootV1 = tag === "entity" ? { entity: name } : { trait: name };
  const composer = catalog.root(root);
  if (composer === undefined) unknownDefinition([...path, tag], tag, name);
  return { root, composer: composer! };
};

const validateParams = (raw: unknown): ReadonlyMap<string, QueryJsonValue> => {
  if (raw === undefined) return new Map();
  if (!isPlainObject(raw)) return malformed(["params"], "params is an object of plain values") as never;
  const out = new Map<string, QueryJsonValue>();
  for (const key of Object.keys(raw).sort()) {
    assertName(key, ["params", key], "a parameter name");
    out.set(key, assertJson(raw[key], ["params", key]));
  }
  return out;
};

const validateBindings = (
  raw: unknown,
  scope: Scope,
): { readonly bindings: readonly ResolvedBindingV1[]; readonly vars: Map<string, ValueTypeV1> } => {
  const vars = new Map<string, ValueTypeV1>();
  if (raw === undefined) return { bindings: [], vars };
  if (!Array.isArray(raw)) {
    return malformed(["let"], "let is an ordered array of { as, expr } bindings") as never;
  }
  const bindings: ResolvedBindingV1[] = [];
  raw.forEach((entry, i) => {
    const path: QueryDocumentPath = ["let", i];
    if (!isPlainObject(entry)) malformed(path, "a binding is { as, expr }");
    const obj = entry as Record<string, unknown>;
    const extra = Object.keys(obj).filter((k) => k !== "as" && k !== "expr");
    if (extra.length > 0) malformed(path, `a binding has no member "${extra[0]}"`);
    const name = assertName(obj["as"], [...path, "as"], "a binding name");
    if (vars.has(name)) malformed([...path, "as"], `"${name}" is bound twice`);
    // The scope handed to this expression holds only the bindings written
    // before it: forward references and self-reference are out of scope,
    // so an ordered list cannot express a cycle.
    const expr = resolveExpr({ ...scope, vars }, obj["expr"], [...path, "expr"], "let", false, 0);
    vars.set(name, expr.type);
    bindings.push({ name, expr });
  });
  return { bindings, vars };
};

const validateProjection = (
  raw: unknown,
  scope: Scope,
  owner: AnyComposer,
  path: QueryDocumentPath,
  depth: number,
): readonly ResolvedSelectionV1[] => {
  if (!isPlainObject(raw)) return malformed(path, "select is an object of projected columns") as never;
  const keys = Object.keys(raw);
  if (keys.length === 0) return malformed(path, "select names at least one column") as never;
  if (depth > 8) return malformed(path, "select nests deeper than the document allows") as never;
  return keys.map((key) => {
    const at: QueryDocumentPath = [...path, key];
    assertKey(key, at);
    const node = raw[key];
    // A nested projection's rows belong to the traversed entity; root
    // bindings and derived values are not in scope there.
    const fieldOnly = depth > 1;
    if (isPlainObject(node) && Object.hasOwn(node, "select")) {
      const extra = Object.keys(node).filter((k) => k !== "select" && k !== "path");
      if (extra.length > 0) malformed(at, `a nested projection has no member "${extra[0]}"`);
      const steps = resolveFieldPath({ ...scope, root: owner }, node["path"], [...at, "path"]);
      if (steps.length !== 1) {
        malformed(
          [...at, "path"],
          "a nested projection traverses one reference — nest another projection to go deeper",
        );
      }
      const step = steps[0]!;
      if (step.field.type !== "ref") {
        malformed([...at, "path"], `"${step.field.key}" is not a reference`);
      }
      const target = scope.catalog.target(owner, step.field);
      if (target === undefined) unknownDefinition([...at, "path"], "reference target", step.field.key);
      return {
        kind: "nested" as const,
        key,
        step,
        target: target!,
        select: validateProjection(node["select"], scope, target!, [...at, "select"], depth + 1),
      };
    }
    const expr = resolveExpr({ ...scope, root: owner }, node, at, "select", false, 0);
    if (fieldOnly && expr.kind !== "field") {
      malformed(at, "a nested projection selects fields of the traversed entity");
    }
    if (expr.kind === "field" && expr.steps.length !== 1) {
      malformed(
        at,
        "a projected field belongs to the entity being projected — reach across a reference with a nested select",
      );
    }
    if (expr.kind === "field" && expr.type === "ref") {
      const leaf = expr.steps[expr.steps.length - 1]!.field;
      if (expr.many) {
        malformed(
          at,
          `"${leaf.key}" is a collection of references — project it with a nested select`,
        );
      }
      // A reference projected without a nested shape reads as its `{ id }`
      // cell, which needs a visible target to name.
      if (leaf.key !== "id" && scope.catalog.target(owner, leaf) === undefined) {
        unknownDefinition(at, "reference target", leaf.key);
      }
    }
    return { kind: "expr" as const, key, expr };
  });
};

const validateOrderBy = (raw: unknown, scope: Scope): readonly ResolvedOrderV1[] => {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return malformed(["orderBy"], "orderBy is an array of sort keys") as never;
  return raw.map((entry, i) => {
    const path: QueryDocumentPath = ["orderBy", i];
    if (!isPlainObject(entry)) malformed(path, "a sort key is { expr, direction?, empty? }");
    const obj = entry as Record<string, unknown>;
    const extra = Object.keys(obj).filter(
      (k) => k !== "expr" && k !== "direction" && k !== "empty",
    );
    if (extra.length > 0) malformed(path, `a sort key has no member "${extra[0]}"`);
    const direction = obj["direction"] ?? "asc";
    if (direction !== "asc" && direction !== "desc") {
      malformed([...path, "direction"], 'direction is "asc" or "desc"');
    }
    const empty = obj["empty"] ?? "last";
    if (empty !== "first" && empty !== "last") {
      malformed([...path, "empty"], 'empty is "first" or "last"');
    }
    const expr = resolveExpr(scope, obj["expr"], [...path, "expr"], "orderBy", false, 0);
    if (expr.kind === "field") {
      if (expr.many) {
        malformed(
          [...path, "expr"],
          "a sort key crosses no cardinality-many field — the key would be a set, not a value",
        );
      }
      return {
        key: { kind: "field" as const, steps: expr.steps },
        direction: direction as "asc" | "desc",
        empty: empty as "first" | "last",
      };
    }
    if (expr.kind === "var") {
      return {
        key: { kind: "var" as const, name: expr.name },
        direction: direction as "asc" | "desc",
        empty: empty as "first" | "last",
      };
    }
    return malformed(
      [...path, "expr"],
      "a sort key is a { field } path or a { var } — bind a computed key in let first",
    ) as never;
  });
};

const validatePage = (
  raw: unknown,
  limits: QueryLimitsV1,
  cardinality: CardinalityV1,
  orderKeys: number,
): { readonly first: number | null; readonly after: string | null; readonly offset: number | null } => {
  const path: QueryDocumentPath = ["page"];
  const empty = cardinality === "one"
    ? { first: null, after: null, offset: null }
    : { first: limits.defaultPageSize, after: null, offset: null };
  if (raw === undefined) return empty;
  if (!isPlainObject(raw)) return malformed(path, "page is { first?, after?, offset? }") as never;
  const extra = Object.keys(raw).filter((k) => k !== "first" && k !== "after" && k !== "offset");
  if (extra.length > 0) malformed(path, `page has no member "${extra[0]}"`);
  // A normalized `page` of all-null members is the same statement as no
  // page member at all — that is what makes normalization idempotent.
  const stated = ["first", "after", "offset"].filter((k) => member(raw, k) !== undefined);
  if (stated.length === 0) return empty;
  if (cardinality === "one") {
    return malformed(path, 'a cardinality "one" query answers one row — it does not page') as never;
  }
  const count = (value: unknown, key: "first" | "offset", min: number): number | null => {
    if (value === undefined) return null;
    if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
      return malformed([...path, key], `${key} is an integer >= ${min}`) as never;
    }
    return value;
  };
  const first = count(member(raw, "first"), "first", 1) ?? limits.defaultPageSize;
  const offset = count(member(raw, "offset"), "offset", 0);
  let after: string | null = null;
  if (member(raw, "after") !== undefined) {
    if (typeof raw["after"] !== "string" || raw["after"].length === 0) {
      malformed([...path, "after"], "after is the opaque cursor a previous page returned");
    }
    after = raw["after"] as string;
  }
  if (after !== null && offset !== null) {
    malformed(path, "after and offset both say where the page starts — a cursor already is the offset");
  }
  if (after !== null && orderKeys === 0) {
    malformed(path, "a cursor is a position in a sort — page a query that orders");
  }
  return { first, after, offset };
};

// ── complexity ──────────────────────────────────────────────────────────────

interface Tally {
  projectionNodes: number;
  projectionDepth: number;
  traversals: number;
  expressionDepth: number;
  expressionNodes: number;
  callCount: number;
  callCost: number;
}

const tallyExpr = (expr: ResolvedExprV1, tally: Tally, depth: number): void => {
  tally.expressionNodes += 1;
  if (depth > tally.expressionDepth) tally.expressionDepth = depth;
  if (expr.kind === "field") {
    tally.traversals += expr.steps.length - 1;
    return;
  }
  if (expr.kind === "call") {
    tally.callCount += 1;
    tally.callCost += expr.def.signature.cost;
    for (const arg of expr.args) tallyExpr(arg, tally, depth + 1);
  }
};

const tallyProjection = (
  select: readonly ResolvedSelectionV1[],
  tally: Tally,
  depth: number,
): void => {
  if (depth > tally.projectionDepth) tally.projectionDepth = depth;
  for (const sel of select) {
    tally.projectionNodes += 1;
    if (sel.kind === "nested") {
      tally.traversals += 1;
      tallyProjection(sel.select, tally, depth + 1);
    } else {
      tallyExpr(sel.expr, tally, 1);
    }
  }
};

/** The default full-entity row, accounted exactly as if it were written out. */
const tallyDefaultRow = (root: AnyComposer, tally: Tally): void => {
  const fields = root.fields as unknown as Record<string, { readonly valueType?: unknown }>;
  tally.projectionNodes += 1; // id
  let refs = 0;
  for (const key of Object.keys(fields)) {
    tally.projectionNodes += 1;
    if (fields[key]?.valueType === "ref") {
      refs += 1;
      tally.traversals += 1;
      tally.projectionNodes += 1; // the nested `{ id }` cell
    }
  }
  if (tally.projectionDepth < (refs > 0 ? 2 : 1)) tally.projectionDepth = refs > 0 ? 2 : 1;
};

const complexityOf = (
  resolved: ResolvedQueryDocumentV1,
  limits: QueryLimitsV1,
): QueryComplexityV1 => {
  const tally: Tally = {
    projectionNodes: 0,
    projectionDepth: 0,
    traversals: 0,
    expressionDepth: 0,
    expressionNodes: 0,
    callCount: 0,
    callCost: 0,
  };
  if (resolved.select === null) tallyDefaultRow(resolved.root, tally);
  else tallyProjection(resolved.select, tally, 1);
  for (const binding of resolved.bindings) tallyExpr(binding.expr, tally, 1);
  if (resolved.where !== null) tallyExpr(resolved.where, tally, 1);
  for (const order of resolved.orderBy) {
    if (order.key.kind === "field") {
      tally.expressionNodes += 1;
      tally.traversals += order.key.steps.length - 1;
      if (tally.expressionDepth < 1) tally.expressionDepth = 1;
    }
  }
  const pageSize =
    resolved.cardinality === "one" ? 1 : (resolved.page.first ?? limits.defaultPageSize);
  const rowCost =
    tally.projectionNodes +
    tally.expressionNodes +
    4 * tally.traversals +
    tally.callCost +
    2 * resolved.orderBy.length;
  return {
    projectionNodes: tally.projectionNodes,
    projectionDepth: tally.projectionDepth,
    traversals: tally.traversals,
    expressionDepth: tally.expressionDepth,
    expressionNodes: tally.expressionNodes,
    callCount: tally.callCount,
    bindingCount: resolved.bindings.length,
    orderKeys: resolved.orderBy.length,
    pageSize,
    rowCost,
    cost: rowCost * pageSize,
  };
};

const BOUNDS: readonly (readonly [keyof QueryComplexityV1, keyof QueryLimitsV1, string])[] = [
  ["projectionNodes", "maxProjectionNodes", "projected columns"],
  ["projectionDepth", "maxProjectionDepth", "projection depth"],
  ["traversals", "maxTraversals", "reference traversals"],
  ["expressionDepth", "maxExpressionDepth", "expression depth"],
  ["expressionNodes", "maxExpressionNodes", "expression nodes"],
  ["callCount", "maxCallCount", "function calls"],
  ["bindingCount", "maxBindingCount", "let bindings"],
  ["orderKeys", "maxOrderKeys", "sort keys"],
  ["pageSize", "maxPageSize", "page size"],
  ["cost", "maxCost", "query cost"],
];

const assertWithinLimits = (complexity: QueryComplexityV1, limits: QueryLimitsV1): void => {
  for (const [key, bound, label] of BOUNDS) {
    const spent = complexity[key];
    const allowed = limits[bound];
    if (spent > allowed) {
      raise("budget_exceeded", [], `${label}: ${spent} exceeds the limit of ${allowed}`);
    }
  }
};

// ── normalization ───────────────────────────────────────────────────────────

const normalizeExpr = (node: ExpressionV1): ExpressionV1 => {
  if ("field" in node) return { field: [...node.field] };
  if ("value" in node) return { value: assertJson(node.value, []) };
  if ("param" in node) return { param: node.param };
  if ("var" in node) return { var: node.var };
  return { call: node.call, args: node.args.map(normalizeExpr) };
};

const normalizeSelection = (raw: Record<string, unknown>): ProjectionV1 => {
  const out: Record<string, ProjectionV1[string]> = {};
  for (const key of Object.keys(raw)) {
    const node = raw[key];
    if (isPlainObject(node) && Object.hasOwn(node, "select")) {
      out[key] = {
        path: [...(node["path"] as readonly string[])],
        select: normalizeSelection(node["select"] as Record<string, unknown>),
      };
    } else {
      out[key] = normalizeExpr(node as ExpressionV1);
    }
  }
  return out;
};

// ── the entry point ─────────────────────────────────────────────────────────

/**
 * Validate, resolve, normalize, and price one document. Throws nothing:
 * the caller in `compile.ts` turns the internal issue into a `Result`.
 *
 * @internal
 */
export const validateQueryDocumentUnsafe = (
  input: unknown,
  options: ValidateOptionsV1,
): ValidatedQueryDocumentV1 => {
  const limits = options.limits ?? DEFAULT_QUERY_LIMITS;
  if (!isPlainObject(input)) malformed([], "a query document is an object");
  const raw = input as Record<string, unknown>;
  const extra = Object.keys(raw).filter(
    (k) =>
      ![
        "version",
        "from",
        "params",
        "let",
        "where",
        "select",
        "orderBy",
        "page",
        "cardinality",
      ].includes(k),
  );
  if (extra.length > 0) malformed([extra[0]!], `a query document has no member "${extra[0]}"`);
  if (raw["version"] !== QUERY_DOCUMENT_VERSION) {
    raise(
      "unsupported_version",
      ["version"],
      `this compiler speaks query document version ${QUERY_DOCUMENT_VERSION}`,
    );
  }
  const { root, composer } = validateRoot(raw["from"], options.catalog);
  const params = validateParams(member(raw, "params"));

  const cardinalityRaw = member(raw, "cardinality") ?? "many";
  if (cardinalityRaw !== "one" && cardinalityRaw !== "many") {
    malformed(["cardinality"], 'cardinality is "one" or "many"');
  }
  const cardinality = cardinalityRaw as CardinalityV1;

  const base: Scope = {
    catalog: options.catalog,
    registry: options.registry,
    root: composer,
    params,
    vars: new Map(),
  };
  const { bindings, vars } = validateBindings(member(raw, "let"), base);
  const scope: Scope = { ...base, vars };

  const whereRaw = member(raw, "where");
  const where =
    whereRaw === undefined ? null : resolveExpr(scope, whereRaw, ["where"], "where", true, 0);
  if (where !== null && !assignable(where.type, "boolean")) {
    malformed(["where"], `a filter is a boolean, got ${where.type}`);
  }
  if (where !== null && where.kind === "constant") {
    malformed(["where"], "a filter constrains the row — it is a field, a binding, or a call");
  }

  const selectRaw = member(raw, "select");
  const select =
    selectRaw === undefined ? null : validateProjection(selectRaw, scope, composer, ["select"], 1);
  // A row of only derived values has no entity behind it: the engine has no
  // focus to break a cursor tie on, and two entities that compute the same
  // value would collapse into one row. v1 requires at least one column of
  // the entity itself. Lifting this later is additive.
  if (select !== null && !select.some((s) => s.kind === "nested" || s.expr.kind === "field")) {
    malformed(
      ["select"],
      "a projection names at least one field of the entity — a row of only derived values has no entity to page or distinguish rows by",
    );
  }
  const orderByRaw = member(raw, "orderBy");
  const orderBy = validateOrderBy(orderByRaw, scope);
  const page = validatePage(member(raw, "page"), limits, cardinality, orderBy.length);

  const resolved: ResolvedQueryDocumentV1 = {
    root: composer,
    bindings,
    where,
    select,
    orderBy,
    page,
    cardinality,
  };
  const complexity = complexityOf(resolved, limits);
  assertWithinLimits(complexity, limits);

  const document: NormalizedQueryDocumentV1 = {
    version: QUERY_DOCUMENT_VERSION,
    from: root,
    params: Object.fromEntries([...params.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
    let: ((member(raw, "let") as readonly BindingV1[] | undefined) ?? []).map((b) => ({
      as: b.as,
      expr: normalizeExpr(b.expr),
    })),
    where: whereRaw === undefined ? null : normalizeExpr(whereRaw as ExpressionV1),
    select: selectRaw === undefined ? null : normalizeSelection(selectRaw as Record<string, unknown>),
    orderBy: orderBy.map(
      (o, i): NormalizedOrderV1 => ({
        expr: normalizeExpr((orderByRaw as readonly { expr: ExpressionV1 }[])[i]!.expr),
        direction: o.direction,
        empty: o.empty,
      }),
    ),
    page,
    cardinality,
  };
  return { document, resolved, complexity };
};

/** @internal Recognize the internal issue carrier at the compile boundary. */
export const issueOf = (error: unknown): QueryDocumentIssueV1 | undefined =>
  error instanceof Issue ? error.issue : undefined;
