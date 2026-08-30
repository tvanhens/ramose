/**
 * `QueryDocumentV1` — the one canonical plain-data query representation.
 *
 * A query document is inert JSON: a versioned, tagged-object grammar with
 * no mini-languages. Field paths are arrays of names, never a dotted
 * string; every expression node carries exactly one tag; bindings are an
 * ordered list of `{ as, expr }` containers. Nothing here knows about MCP,
 * HTTP, or any transport — the document is the shared front door that a
 * wire envelope, a frontend builder, or a non-TypeScript client all speak.
 *
 * The document is *not* a second engine. It compiles (see `compile.ts`)
 * into the existing authoritative query representation — a `QueryObject`
 * over the same pipeline, kernel clauses, and pull shapes the fluent
 * builder produces.
 */

/**
 * Plain JSON — the only values a document may carry.
 *
 * Values JSON cannot represent natively use Ramose's existing canonical
 * encoding, the same one the HTTP API, the DO RPC bodies, and
 * `Query.encodeCursor` already round-trip:
 *
 * - `{ "$inst": 1767225600000 }` — an instant (epoch milliseconds; an
 *   ISO-8601 string is accepted and normalized to the number).
 * - `{ "$uuid": "…" }` — a UUID, normalized to lower case.
 * - `{ "$bytes": "<base64>" }` — bytes.
 *
 * An entity id is a plain number; the public document has no other
 * spelling of one. Every *other* `$`-prefixed object key is refused, which
 * is what keeps a future tagged encoding additive: no document carrying an
 * unrecognized `$` tag was ever accepted, so none can be reinterpreted.
 */
export type QueryJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly QueryJsonValue[]
  | { readonly [key: string]: QueryJsonValue };

/** The typed-value tags a `{ value }` literal or a parameter may carry. */
export const QUERY_VALUE_TAGS = ["$inst", "$uuid", "$bytes"] as const;

/** The grammar version this module defines and compiles. */
export const QUERY_DOCUMENT_VERSION = 1;

/** Canonical `$id` of the published JSON Schema for {@link QueryDocumentV1}. */
export const QUERY_DOCUMENT_SCHEMA_ID =
  "https://ramose.ai/schema/query-document-v1.json";

// ── expressions ─────────────────────────────────────────────────────────────

/**
 * One expression node. Exactly one tag per node — a node carrying two tags
 * (or none) is malformed, so there is no ambiguous shorthand to disagree
 * about. `call` is the only structural node; every comparison, boolean
 * connective, and transformation is a `call` resolved through the function
 * registry (#507), never a wire-level operator.
 */
export type ExpressionV1 =
  | { readonly field: readonly string[] }
  | { readonly value: QueryJsonValue }
  | { readonly param: string }
  | { readonly var: string }
  | { readonly call: string; readonly args: readonly ExpressionV1[] };

/** The five expression tags, in canonical order. */
export const EXPRESSION_TAGS = ["field", "value", "param", "var", "call"] as const;

export type ExpressionTag = (typeof EXPRESSION_TAGS)[number];

/**
 * One ordered `let` binding. Bindings are lexically scoped in document
 * order: an expression sees the bindings written before it and no others,
 * so there is no second public `pipe` syntax and no cycles to resolve.
 */
export interface BindingV1 {
  readonly as: string;
  readonly expr: ExpressionV1;
}

/** Where an expression appears. Each function declares the contexts it serves. */
export type ExpressionContextV1 = "let" | "where" | "select" | "orderBy";

/**
 * The value vocabulary shared by field types, function signatures, and the
 * derived result shape. `json` is an opaque plain value; `any` is the
 * unconstrained position a registry may declare for a generic function.
 */
export type ValueTypeV1 =
  | "boolean"
  | "number"
  | "string"
  | "instant"
  | "uuid"
  | "bytes"
  | "ref"
  | "json"
  | "any";

// ── roots, projections, ordering, paging ────────────────────────────────────

/** The scan root: one entity type, or every type composing one trait. */
export type QueryRootV1 =
  | { readonly entity: string }
  | { readonly trait: string };

/**
 * A nested projection over a relation. `path` is a field path (arrays, not
 * a mini-language); v1 traverses exactly one reference hop per nesting
 * level — deeper traversal nests another projection, which keeps the
 * derived row shape and the traversal budget in step.
 */
export interface NestedSelectionV1 {
  readonly path: readonly string[];
  readonly select: ProjectionV1;
}

/** One projected column: an expression, or a nested relation projection. */
export type SelectionV1 = ExpressionV1 | NestedSelectionV1;

export interface ProjectionV1 {
  readonly [key: string]: SelectionV1;
}

export type OrderDirectionV1 = "asc" | "desc";
export type OrderEmptyV1 = "first" | "last";

/**
 * One sort key. `expr` is a `{ field }` path or a `{ var }` naming a
 * binding — a call is ordered by binding it in `let` first, which keeps
 * long expression chains shallow and named.
 */
export interface OrderV1 {
  readonly expr: ExpressionV1;
  readonly direction?: OrderDirectionV1;
  readonly empty?: OrderEmptyV1;
}

/**
 * Page bounds. `after` is the opaque cursor a previous page returned;
 * `offset` is the non-keyset alternative. They are mutually exclusive —
 * a cursor already says where the page starts.
 */
export interface PageV1 {
  readonly first?: number;
  readonly after?: string;
  readonly offset?: number;
}

/** How many rows the document answers with. */
export type CardinalityV1 = "one" | "many";

/** The document. Every optional member has an explicit normalized form. */
export interface QueryDocumentV1 {
  readonly version: 1;
  readonly from: QueryRootV1;
  readonly params?: { readonly [name: string]: QueryJsonValue };
  readonly let?: readonly BindingV1[];
  readonly where?: ExpressionV1;
  readonly select?: ProjectionV1;
  readonly orderBy?: readonly OrderV1[];
  readonly page?: PageV1;
  readonly cardinality?: CardinalityV1;
}

// ── the normalized document ─────────────────────────────────────────────────

export interface NormalizedOrderV1 {
  readonly expr: ExpressionV1;
  readonly direction: OrderDirectionV1;
  readonly empty: OrderEmptyV1;
}

export interface NormalizedPageV1 {
  readonly first: number | null;
  readonly after: string | null;
  readonly offset: number | null;
}

/**
 * The canonical form of a validated document: every default made explicit,
 * every node reduced to its tag members, and the effective page bound
 * written down rather than applied silently. Two documents that mean the
 * same query normalize to the same value and serialize to the same bytes.
 */
export interface NormalizedQueryDocumentV1 {
  readonly version: 1;
  readonly from: QueryRootV1;
  readonly params: { readonly [name: string]: QueryJsonValue };
  readonly let: readonly BindingV1[];
  readonly where: ExpressionV1 | null;
  /** `null` is the default full-entity row — the same row a select-less
   * fluent query yields. */
  readonly select: ProjectionV1 | null;
  readonly orderBy: readonly NormalizedOrderV1[];
  readonly page: NormalizedPageV1;
  readonly cardinality: CardinalityV1;
}

// ── budgets ─────────────────────────────────────────────────────────────────

/**
 * What one document costs, computed before execution. Every number walks
 * the whole document — nested projections and nested expressions included —
 * so nesting cannot hide work from the bound that rejects it.
 */
export interface QueryComplexityV1 {
  /** Projected leaves plus nested containers, at every depth. */
  readonly projectionNodes: number;
  /** Deepest nested projection level. */
  readonly projectionDepth: number;
  /** Reference hops crossed by projections and expression field paths. */
  readonly traversals: number;
  /** Deepest expression tree in the document. */
  readonly expressionDepth: number;
  /** Every expression node in the document. */
  readonly expressionNodes: number;
  /** Every `call` node, at every depth. */
  readonly callCount: number;
  readonly bindingCount: number;
  readonly orderKeys: number;
  /** Rows the document may return — the effective `page.first`, or 1. */
  readonly pageSize: number;
  /** Per-row weighted work: nodes, hops, and each call's declared cost. */
  readonly rowCost: number;
  /** `rowCost * pageSize` — the number the budget compares. */
  readonly cost: number;
}

/** Static bounds every document is checked against before it executes. */
export interface QueryLimitsV1 {
  readonly maxProjectionNodes: number;
  readonly maxProjectionDepth: number;
  readonly maxTraversals: number;
  readonly maxExpressionDepth: number;
  readonly maxExpressionNodes: number;
  readonly maxCallCount: number;
  readonly maxBindingCount: number;
  readonly maxOrderKeys: number;
  readonly maxPageSize: number;
  /** The page a document that asked for none is normalized to. Written into
   * the normalized document, never applied behind the caller's back. */
  readonly defaultPageSize: number;
  readonly maxCost: number;
}

export const DEFAULT_QUERY_LIMITS: QueryLimitsV1 = {
  maxProjectionNodes: 64,
  maxProjectionDepth: 4,
  maxTraversals: 16,
  maxExpressionDepth: 8,
  maxExpressionNodes: 128,
  maxCallCount: 32,
  maxBindingCount: 16,
  maxOrderKeys: 4,
  maxPageSize: 500,
  defaultPageSize: 100,
  maxCost: 40_000,
};

// ── derived result shape ────────────────────────────────────────────────────

/**
 * What one row of the compiled query looks like — enough for a typed
 * client to generate a row type and for a capability card to describe the
 * result without executing anything.
 */
export type ResultShapeV1 =
  | { readonly kind: "scalar"; readonly type: ValueTypeV1; readonly optional: boolean }
  | {
      /** An `{ id }` cell: a reference projected without a nested shape. */
      readonly kind: "reference";
      readonly entity: string | null;
      readonly optional: boolean;
    }
  | {
      readonly kind: "object";
      readonly fields: { readonly [key: string]: ResultShapeV1 };
      readonly optional: boolean;
    }
  | { readonly kind: "list"; readonly element: ResultShapeV1 };

export interface QueryResultShapeV1 {
  readonly row: ResultShapeV1;
  readonly cardinality: CardinalityV1;
  /** A cursor-paged query answers `{ rows, cursor }`, not a bare array. */
  readonly paged: boolean;
}

// ── issues ──────────────────────────────────────────────────────────────────

/**
 * Why a document was rejected.
 *
 * `malformed` is a statement about the document the caller sent and may
 * quote the caller's own tokens. `unknown_definition` is deliberately one
 * code for "no such name" and "not visible to you": the compiler resolves
 * names through a filtered catalog that answers `undefined` either way, so
 * the seal is a property of the resolution seam, not of a message this
 * module remembers to redact. `budget_exceeded` names the bound, never the
 * data.
 */
export type QueryDocumentIssueCode =
  | "malformed"
  | "unsupported_version"
  | "unknown_definition"
  | "budget_exceeded";

/** Where an issue is, as a JSON path of members and indices. */
export type QueryDocumentPath = readonly (string | number)[];

export interface QueryDocumentIssueV1 {
  readonly code: QueryDocumentIssueCode;
  readonly path: QueryDocumentPath;
  readonly message: string;
}
