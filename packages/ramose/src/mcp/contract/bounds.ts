/**
 * Explicit public bounds for the MCP kernel wire contract (#485).
 *
 * Every collection the public wire accepts or returns is bounded here, and
 * every bound is deliberately *tighter* than the engine-internal ceiling it
 * sits behind (`internal/authorization/bounds.ts`). A public bound may only
 * ever be relaxed toward the internal one, never past it: the transport must
 * be able to refuse a hostile request before any authorization, catalog, or
 * storage work happens.
 *
 * Nothing here is advisory. A value outside these bounds is an
 * `invalid_input` / `invalid_query` error envelope, never a silently
 * truncated result.
 */

/** Segments in a root-relative graph selector. `[]` is the authorized root. */
export const MAX_GRAPH_PATH_SEGMENTS = 32;

/** Characters in one graph path segment. */
export const MAX_GRAPH_PATH_SEGMENT_LENGTH = 256;

/** Characters in a public semantic name (entity, trait, field, operation). */
export const MAX_PUBLIC_NAME_LENGTH = 128;

/** Characters in a public function namespace (`text`, `logic`, ...). */
export const MAX_FUNCTION_NAMESPACE_LENGTH = 64;

/** Characters in the opaque body of any public token or cursor. */
export const MAX_OPAQUE_TOKEN_BODY_LENGTH = 512;

/** Characters in a caller-minted invocation id. Mirrors the durable bound. */
export const MAX_INVOCATION_ID_LENGTH = 256;

/** Characters in a Resource URI, including scheme and kind. */
export const MAX_RESOURCE_URI_LENGTH = 640;

/** Characters in free-text discovery input. Fuzzy text is never addressable. */
export const MAX_SEARCH_LENGTH = 256;

/** Characters in a public application-visible instance id. */
export const MAX_PUBLIC_INSTANCE_ID_LENGTH = 256;

/** Characters in an error envelope `message`. */
export const MAX_ERROR_MESSAGE_LENGTH = 1_024;

/** Characters in an error envelope `hint`. */
export const MAX_ERROR_HINT_LENGTH = 512;

/** Segments in an error envelope `path`. */
export const MAX_ERROR_PATH_SEGMENTS = 32;

/** Characters in a card `title`. */
export const MAX_CARD_TITLE_LENGTH = 128;

/** Characters in a card `description`. */
export const MAX_CARD_DESCRIPTION_LENGTH = 4_096;

/** Smallest page a caller may ask for. */
export const MIN_PAGE_SIZE = 1;

/** Largest page a caller may ask for, on `describe` and on `query`. */
export const MAX_PAGE_SIZE = 200;

/** Page size applied when a caller does not ask for one. */
export const DEFAULT_PAGE_SIZE = 25;

/** Entries in one `describe` listing page. Never exceeds {@link MAX_PAGE_SIZE}. */
export const MAX_DESCRIBE_ITEMS = MAX_PAGE_SIZE;

/** Rows in one `query` page. Never exceeds {@link MAX_PAGE_SIZE}. */
export const MAX_QUERY_ROWS = MAX_PAGE_SIZE;

/** Selected columns in one query row. */
export const MAX_QUERY_ROW_COLUMNS = 128;

/** Discovery kinds a single `describe` request may ask for. */
export const MAX_DESCRIBE_KINDS = 8;

/** Fields listed on one definition card. */
export const MAX_CARD_FIELDS = 256;

/** Operations listed on one definition card. */
export const MAX_CARD_OPERATIONS = 256;

/** Traits listed on one definition card. */
export const MAX_CARD_TRAITS = 64;
