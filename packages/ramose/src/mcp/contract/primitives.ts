/**
 * Shared public primitives of the MCP kernel wire contract (#485).
 *
 * Everything in this file is plain data. The contract is defined by the JSON
 * Schema 2020-12 documents these schemas emit, not by the TypeScript types —
 * the types exist so the projection (#488) and transport (#489) cannot drift
 * from the published schemas by accident.
 *
 * Two rules govern every value here.
 *
 * 1. **Semantic or opaque, never internal.** A public value is either a
 *    semantic application name the caller already knows (`issue`, `close`) or
 *    an opaque handle the caller must echo verbatim and must never parse.
 *    Database ids, catalog keys, unit hashes, transaction ids, storage
 *    locators, internal function names, and implementation symbols never
 *    appear — see `serialization.ts`, which enforces this mechanically.
 * 2. **Possession is not authority.** No token, cursor, URI, version, or
 *    receipt in this module grants access to anything. Authorization is
 *    revalidated independently on every request (#424).
 */

import * as Schema from "effect/Schema";
import { JsonValue } from "../../internal/authorization/json.ts";
import {
  MAX_GRAPH_PATH_SEGMENT_LENGTH,
  MAX_GRAPH_PATH_SEGMENTS,
  MAX_INVOCATION_ID_LENGTH,
  MAX_OPAQUE_TOKEN_BODY_LENGTH,
  MAX_PAGE_SIZE,
  MAX_PUBLIC_INSTANCE_ID_LENGTH,
  MAX_RESOURCE_URI_LENGTH,
  MIN_PAGE_SIZE,
} from "./bounds.ts";

/**
 * The public JSON value.
 *
 * Its *type* is the engine's `JsonValue`, so the wire and the canonicalizer
 * that serializes it can never disagree about what JSON is. The schema is
 * restated here for one reason: the published `$defs` name has to be
 * `JsonValueV1`. Annotating the engine's suspended schema leaves the inner
 * union unnamed and the generator invents one, and an invented name in a
 * frozen contract is a wire alias nobody chose.
 */
export const JsonValueV1: Schema.Codec<JsonValue> = Schema.suspend(() =>
  Schema.Union([
    Schema.String,
    Schema.Finite,
    Schema.Boolean,
    Schema.Null,
    Schema.Array(JsonValueV1),
    Schema.Record(Schema.String, JsonValueV1),
  ]).annotate({
    identifier: "JsonValueV1",
    description:
      "Any JSON value: string, finite number, boolean, null, array, or object.",
  })
);
export type JsonValueV1 = JsonValue;

/**
 * A JSON object. Deliberately unnamed for the same reason as a JSON Schema
 * node: it carries different things at different sites, and each of them
 * deserves its own description.
 */
export const JsonObjectV1 = Schema.Record(Schema.String, JsonValueV1);
export type JsonObjectV1 = { readonly [key: string]: JsonValue };

// ---------------------------------------------------------------------------
// Opaque handles
// ---------------------------------------------------------------------------

/**
 * Alphabet every opaque public handle body is drawn from: unpadded base64url.
 * It is URL-safe, JSON-safe, and — critically — is *not* lowercase hex, so a
 * public handle can never be mistaken for, or silently become, a raw digest.
 */
export const OPAQUE_BODY_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Prefix on the opaque catalog consistency token. */
export const CATALOG_TOKEN_PREFIX = "cat_";
/** Prefix on an opaque pagination cursor. */
export const CURSOR_PREFIX = "cur_";
/** Prefix on the opaque operation-scoped compatibility version. */
export const OPERATION_VERSION_PREFIX = "ov_";

const opaqueHandle = (
  prefix: string,
  identifier: string,
  description: string,
  bodyLength = MAX_OPAQUE_TOKEN_BODY_LENGTH,
) =>
  Schema.String.check(
    Schema.isPattern(
      new RegExp(`^${prefix}[A-Za-z0-9_-]{1,${bodyLength}}$`),
    ),
  ).annotate({ identifier, description });

/**
 * Effective catalog the server interpreted a request against.
 *
 * Returned by every successful `describe` and `query`. A caller may echo it
 * back as `ifCatalog` to demand that a later request be interpreted against
 * exactly that catalog; omitting it means "use the current authorized
 * catalog". A stale explicit token is a `catalog_changed` envelope, never a
 * silent reinterpretation.
 */
export const CatalogTokenV1 = opaqueHandle(
  CATALOG_TOKEN_PREFIX,
  "CatalogTokenV1",
  "Opaque token naming one authorized catalog. Every successful result carries the catalog it was produced from; send that value back as ifCatalog to pin a follow-up request to it, or omit ifCatalog to use the current catalog. Never parse it.",
);
export type CatalogTokenV1 = string;

/**
 * Opaque continuation handle. A cursor is only meaningful to the server that
 * minted it, is bound to the request that produced it, and expires; it never
 * widens what its bearer may see.
 *
 * ## A cursor carries its own catalog
 *
 * Deterministic paging is a contract invariant: continuing a listing must not
 * silently drop or duplicate entries, and it must not quietly reinterpret the
 * remainder against a catalog the caller never saw. So the catalog a cursor was
 * minted under travels with the cursor, and continuing is pinned to it whether
 * or not the caller restates the pin:
 *
 * - send `ifCatalog` and it must be the cursor's catalog — a different one is
 *   `invalid_input`, because the two arguments would be asking for different
 *   worlds;
 * - omit `ifCatalog` and the cursor's catalog is still used, not the current
 *   one. A cursor is not a way to opt out of the pin;
 * - if that catalog is no longer available, the continuation is
 *   `catalog_changed` and the caller restarts the listing. Never a silent
 *   restart, and never a page interpreted against something else.
 */
export const CursorV1 = opaqueHandle(
  CURSOR_PREFIX,
  "CursorV1",
  "Opaque pagination cursor. A result carries one exactly when more entries exist; pass it back unchanged as the next request's cursor to continue that one listing, with the rest of the request unchanged. A cursor is pinned to the catalog it was minted under: an ifCatalog naming a different catalog is invalid_input, omitting ifCatalog still uses the cursor's catalog, and a catalog that has moved on is catalog_changed. Never parse or construct one.",
);
export type CursorV1 = string;

/**
 * Caller-minted idempotency key for exactly one authoritative invocation.
 *
 * Reusing it with identical arguments replays the original outcome; reusing
 * it with different arguments is `invocation_conflict`. It is caller data:
 * the contract bounds its length and nothing else.
 */
export const InvocationIdV1 = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_INVOCATION_ID_LENGTH),
).annotate({
  identifier: "InvocationIdV1",
  description:
    "Caller-minted idempotency key for one mutation. Reuse it verbatim to recover the original outcome of the same invocation.",
});
export type InvocationIdV1 = string;

// ---------------------------------------------------------------------------
// Resource handles
// ---------------------------------------------------------------------------

/** URI scheme for every Ramose MCP Resource. */
export const RESOURCE_URI_SCHEME = "ramose";

/** Resource families the kernel contract knows about. */
export const RESOURCE_KINDS = Object.freeze(
  ["capability", "query"] as const,
);
export type ResourceKindV1 = (typeof RESOURCE_KINDS)[number];

const RESOURCE_URI_PATTERN =
  /^ramose:\/\/(capability|query)\/[A-Za-z0-9_-]{1,512}$/;

/**
 * A Resource URI. The path after the kind is one opaque handle; it carries no
 * database, catalog, or storage identity and grants nothing on its own.
 */
export const ResourceUriV1 = Schema.String.check(
  Schema.isMaxLength(MAX_RESOURCE_URI_LENGTH),
  Schema.isPattern(RESOURCE_URI_PATTERN),
).annotate({
  identifier: "ResourceUriV1",
  description:
    "Ramose MCP Resource URI of the form ramose://<kind>/<opaque-handle>. The handle is opaque and confers no authority.",
});
export type ResourceUriV1 = string;

/** Build a Resource URI from its kind and an already-opaque handle. */
export const resourceUri = (
  kind: ResourceKindV1,
  handle: string,
): ResourceUriV1 => `${RESOURCE_URI_SCHEME}://${kind}/${handle}`;

/** MIME type every Ramose Resource is served as. */
export const RESOURCE_MIME_TYPE = "application/json";

/**
 * An MCP resource link. A client that cannot follow links can always obtain
 * the same content inline, so a link is never the only way to reach a
 * capability.
 */
export const ResourceLinkV1 = Schema.Struct({
  uri: ResourceUriV1,
  mimeType: Schema.Literal(RESOURCE_MIME_TYPE).annotate({
    description: "Always application/json.",
  }),
}).annotate({
  identifier: "ResourceLinkV1",
  description:
    "Optional link to the same content as a Resource. Following it is never required: the inline form is always sufficient.",
});
export type ResourceLinkV1 = {
  readonly uri: ResourceUriV1;
  readonly mimeType: typeof RESOURCE_MIME_TYPE;
};

// ---------------------------------------------------------------------------
// Graph selection
// ---------------------------------------------------------------------------

/** One segment of a root-relative graph path. */
export const GraphPathSegmentV1 = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_GRAPH_PATH_SEGMENT_LENGTH),
).annotate({
  identifier: "GraphPathSegmentV1",
  description: "One graph name, relative to its parent graph.",
});

/**
 * The one graph selector: a path relative to the caller's authorized root.
 *
 * `[]` selects the root itself. Every segment is resolved through the same
 * filtered read the caller would get anyway, so hidden, missing, and
 * unauthorized segments are externally indistinguishable (#419).
 */
export const GraphPathV1 = Schema.Array(GraphPathSegmentV1).check(
  Schema.isMaxLength(MAX_GRAPH_PATH_SEGMENTS),
).annotate({
  identifier: "GraphPathV1",
  description:
    "Root-relative graph selector. [] is the caller's authorized root; each further segment names a child graph. As a request argument it selects the graph and may be omitted for the root; as a result member it is the path the result was produced at, and can be sent back verbatim to address the same graph again.",
});
export type GraphPathV1 = readonly string[];

/** The authorized root. */
export const ROOT_GRAPH_PATH: GraphPathV1 = Object.freeze([]);

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

/** Page size a caller may request. */
export const PageLimitV1 = Schema.Int.check(
  Schema.isBetween({ minimum: MIN_PAGE_SIZE, maximum: MAX_PAGE_SIZE }),
).annotate({
  identifier: "PageLimitV1",
  description:
    `Maximum entries to return, between ${MIN_PAGE_SIZE} and ${MAX_PAGE_SIZE}.`,
});

/**
 * Page metadata returned with every collection.
 *
 * Truncation is never silent: `hasMore` is true exactly when `cursor` is
 * present, and a result that stopped early always says so. See
 * {@link pageInfo}, which is the only supported way to build one.
 */
export const PageInfoV1 = Schema.Struct({
  limit: PageLimitV1,
  returned: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: MAX_PAGE_SIZE }),
  ).annotate({ description: "Number of entries in this page." }),
  hasMore: Schema.Boolean.annotate({
    description:
      "True when more entries exist. True if and only if cursor is present.",
  }),
  cursor: Schema.optionalKey(CursorV1),
}).annotate({
  identifier: "PageInfoV1",
  description:
    "Explicit bounds for one page. A collection is never truncated without hasMore and a cursor.",
});
export type PageInfoV1 = {
  readonly limit: number;
  readonly returned: number;
  readonly hasMore: boolean;
  readonly cursor?: CursorV1;
};

/**
 * Build page metadata, enforcing the no-silent-truncation invariant at the
 * one place pages are constructed.
 */
export const pageInfo = (input: {
  readonly limit: number;
  readonly returned: number;
  readonly cursor?: CursorV1 | undefined;
}): PageInfoV1 => {
  if (
    !Number.isSafeInteger(input.limit) || input.limit < MIN_PAGE_SIZE ||
    input.limit > MAX_PAGE_SIZE
  ) {
    throw new TypeError("ramose/mcp: page limit is outside the public bounds");
  }
  if (
    !Number.isSafeInteger(input.returned) || input.returned < 0 ||
    input.returned > input.limit
  ) {
    throw new TypeError("ramose/mcp: page returned count exceeds its limit");
  }
  return Object.freeze(
    input.cursor === undefined
      ? { limit: input.limit, returned: input.returned, hasMore: false }
      : {
        limit: input.limit,
        returned: input.returned,
        hasMore: true,
        cursor: input.cursor,
      },
  );
};

// ---------------------------------------------------------------------------
// Application-visible instance identity
// ---------------------------------------------------------------------------

/**
 * The public identity of one application row.
 *
 * `id` is the identity the application itself publishes (`ISSUE-8472`), never
 * a database entity id, and it is meaningful only inside `entity` at the `at`
 * path it was returned from.
 */
export const InstanceRefV1 = Schema.Struct({
  entity: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_PUBLIC_INSTANCE_ID_LENGTH),
  ).annotate({ description: "Semantic entity name this instance belongs to." }),
  id: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_PUBLIC_INSTANCE_ID_LENGTH),
  ).annotate({
    description:
      "Application-published identity of the row. Never a database entity id.",
  }),
}).annotate({
  identifier: "InstanceRefV1",
  description:
    "Reference to one application row by its semantic entity name and application-published id. Returned on a query row that projects an identity, and accepted as a mutate target.",
});
export type InstanceRefV1 = {
  readonly entity: string;
  readonly id: string;
};
