/** Closure-free Effect Schema snapshotting for permanent catalog plans. */

import * as Schema from "effect/Schema";
import * as SchemaRepresentation from "effect/SchemaRepresentation";

export type SnapshottedSchemaCodec = {
  readonly decode: (value: unknown) => unknown;
  readonly encode: (value: unknown) => unknown;
};

export type SnapshottedSchema = {
  readonly representation: Schema.Json;
  readonly codec: SnapshottedSchemaCodec;
};

const trustedRevivers = Object.freeze(
  Object.entries(Schema)
    .filter(([name, value]) =>
      name.endsWith("Reviver") &&
      typeof value === "object" && value !== null &&
      typeof (value as { readonly id?: unknown }).id === "string" &&
      typeof (value as { readonly revive?: unknown }).revive === "function"
    )
    .map(([, value]) => {
      const reviver = value as SchemaRepresentation.AnyReviver;
      return Object.freeze({
        id: reviver.id,
        payloadSchema: reviver.payloadSchema,
        revive: reviver.revive,
      }) as SchemaRepresentation.AnyReviver;
    }),
);

/**
 * Serialize and reconstruct a schema using only Effect-owned revivers, then
 * compile codecs from that reconstruction. Opaque/custom callbacks cannot
 * cross this boundary because they have no trusted representation reviver.
 */
export const snapshotSchema = (schema: Schema.Top): SnapshottedSchema => {
  try {
    const representation = SchemaRepresentation.toJson(
      SchemaRepresentation.toRepresentation(schema.ast),
    );
    const restored = SchemaRepresentation.fromRepresentation(
      SchemaRepresentation.fromJson(representation),
      { revivers: trustedRevivers },
    );
    return Object.freeze({
      representation,
      codec: Object.freeze({
        decode: Schema.decodeUnknownSync(restored as Schema.Decoder<unknown>),
        encode: Schema.encodeUnknownSync(restored as Schema.Encoder<unknown>),
      }),
    });
  } catch (cause) {
    throw new Error(
      `schema cannot be sealed without retaining executable callbacks: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
};
