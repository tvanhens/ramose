/**
 * The `query` tool's document seam (#485 ⇄ #486).
 *
 * ## What this is
 *
 * The canonical query document — `QueryDocumentV1`, its `ExpressionV1` nodes,
 * the ordered `BindingV1` list, and the deterministic standard library those
 * expressions may call — is owned by the query module (#486, #507). It is
 * being built in parallel with this contract, and there must be exactly one
 * definition of it: a second, "close enough" copy here would become a second
 * query language the moment the two drifted.
 *
 * So this module defines the *envelope* and nothing else: `query` carries a
 * versioned JSON object, the wire fixes `version: 1`, and the members are
 * passed through untouched.
 *
 * ## Integration seam
 *
 * TODO(#486): once the query module publishes its canonical `QueryDocumentV1`
 * JSON Schema, replace {@link QueryDocumentEnvelopeV1}'s passthrough body with
 * a `$ref` to that schema in the `query` tool's `$defs`. That change is
 * *additive* for a caller that was already sending a valid document — it only
 * narrows what the schema accepts, from "some versioned object" to "exactly
 * the canonical document" — and it does not move the tool, the envelope, the
 * result shape, or the error codes. A caller that was sending a well-formed
 * `QueryDocumentV1` before the follow-up keeps working after it; a caller that
 * was sending something else starts receiving `invalid_query` from the schema
 * instead of from the compiler, which is where it should have come from.
 *
 * Nothing in this contract depends on the document's internals: the `query`
 * envelope, page metadata, catalog token, delivery mode, row shape, and error
 * codes are all defined without looking inside it.
 *
 * ## What the envelope does fix
 *
 * - The document is a JSON **object**, never a string. There is no executable
 *   string form and no shorthand syntax — one canonical data representation,
 *   or nothing.
 * - It carries its own language version, so a future incompatible query
 *   language is a new `version` rather than a silent reinterpretation of the
 *   same members.
 */

import * as Schema from "effect/Schema";
import { JsonValueV1 } from "./primitives.ts";

/** The one query-language version this contract admits. */
export const QUERY_DOCUMENT_VERSION = 1 as const;

/**
 * A versioned query document.
 *
 * Validated here only as "a JSON object whose `version` is 1". The canonical
 * member-level schema arrives with the #486 integration described above.
 */
export const QueryDocumentEnvelopeV1 = Schema.Record(
  Schema.String,
  JsonValueV1,
).annotate({
  // Split deliberately: the description is attached before the version check
  // so it lands on the schema node itself rather than inside the check's own
  // `allOf` fragment, and the identifier is attached after it so the published
  // schema is a named `$defs` entry — which is exactly the `$ref` the #486
  // integration will repoint at the canonical document.
  description:
    "The canonical plain-data query document. Always a JSON object, never an executable string. Members beyond version are defined by the query language at that version.",
}).check(
  Schema.makeFilter(
    (document: { readonly [key: string]: unknown }) =>
      document.version === QUERY_DOCUMENT_VERSION
        ? undefined
        : `query document must declare version ${QUERY_DOCUMENT_VERSION}`,
    {
      title: "versioned query document",
      toJsonSchema: () => ({
        properties: {
          version: {
            type: "integer",
            const: QUERY_DOCUMENT_VERSION,
            description:
              "Query-language version. Only 1 is defined; a future incompatible language is a new version, never a reinterpretation of these members.",
          },
        },
        required: ["version"],
      }),
    },
  ),
).annotate({ identifier: "QueryDocumentEnvelopeV1" });
export type QueryDocumentEnvelopeV1 = {
  readonly version: typeof QUERY_DOCUMENT_VERSION;
  readonly [key: string]: unknown;
};

/**
 * Delivery modes for a query result.
 *
 * `one_shot` is the default and the only mode this contract defines: the
 * result is complete when the tool call returns. Live delivery — a
 * subscribable Resource whose invalidations tell a client to re-read current
 * authorized state — is #541, and it is deliberately *outside* the query
 * document: whether a result is watched is a transport concern, not part of
 * what the query means. Adding `live` here is additive; a client that never
 * sends `delivery` is unaffected.
 */
export const DELIVERY_MODES = Object.freeze(["one_shot"] as const);
export type DeliveryModeV1 = (typeof DELIVERY_MODES)[number];

/** Requested delivery. Omitting it means {@link DELIVERY_MODES}[0]. */
export const DeliveryRequestV1 = Schema.Struct({
  mode: Schema.Literals(DELIVERY_MODES).annotate({
    description:
      "one_shot: the result is complete when this call returns. The default.",
  }),
}).annotate({
  identifier: "DeliveryRequestV1",
  description:
    "Optional delivery request. Defaults to one_shot; live delivery is a separate, additive extension.",
});
export type DeliveryRequestV1 = { readonly mode: DeliveryModeV1 };

/** Delivery the server actually applied. Always echoed on success. */
export const DeliveryInfoV1 = Schema.Struct({
  mode: Schema.Literals(DELIVERY_MODES).annotate({
    description: "Delivery mode this result was produced under.",
  }),
}).annotate({
  identifier: "DeliveryInfoV1",
  description:
    "How this result was delivered. Stated explicitly so a client never has to infer it.",
});
export type DeliveryInfoV1 = { readonly mode: DeliveryModeV1 };

/** The delivery every result uses unless a future extension says otherwise. */
export const DEFAULT_DELIVERY: DeliveryInfoV1 = Object.freeze({
  mode: "one_shot",
});
