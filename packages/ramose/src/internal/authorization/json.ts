/**
 * JSON-only values admitted in IR literals and claim maps.
 * Non-JSON values (functions, symbols, bigint, `NaN`, infinities) are
 * rejected by the structural decoder (#357).
 *
 * The recursive `JsonValue` type exists only to break the inference cycle.
 * `Schema.Codec<JsonValue>` preserves the encoded representation for #357.
 */

import * as Schema from "effect/Schema";

export const JsonScalar = Schema.Union([
  Schema.String,
  Schema.Finite,
  Schema.Boolean,
  Schema.Null,
]);
export type JsonScalar = typeof JsonScalar.Type;

export type JsonValue =
  | JsonScalar
  | ReadonlyArray<JsonValue>
  | { readonly [key: string]: JsonValue };

export const JsonValue: Schema.Codec<JsonValue> = Schema.suspend(() =>
  Schema.Union([
    JsonScalar,
    Schema.Array(JsonValue),
    Schema.Record(Schema.String, JsonValue),
  ]),
);
