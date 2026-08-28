/** Code-first runtime schema bindings paired with inert public projections. */

import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";

/** Serializable metadata for identity, discovery, and public wire projection. */
export type InertSchemaProjection = Schema.Json;

/** Authoritative runtime behavior compiled from the original deployed schema. */
export type DeployedSchemaCodec = {
  readonly decode: (value: unknown) => unknown;
  readonly encode: (value: unknown) => unknown;
};

/**
 * One assembly-time pair. The projection is inert and the codec is private;
 * neither is reconstructed from the other.
 */
export type DeployedSchemaBinding = {
  readonly projection: InertSchemaProjection;
  readonly codec: DeployedSchemaCodec;
};

const freezeJson = <T>(value: T): T => {
  if (value === null || typeof value !== "object") return value;
  for (const child of Object.values(value)) freezeJson(child);
  return Object.isFrozen(value) ? value : Object.freeze(value);
};

const assertRepresentableWireContract = (
  input: SchemaAST.AST,
  seen = new Set<SchemaAST.AST>(),
): void => {
  const ast = SchemaAST.toEncoded(input);
  if (seen.has(ast)) return;
  seen.add(ast);
  if (
    ast._tag === "Declaration" &&
    ast.annotations?.toCodecJson === undefined &&
    ast.annotations?.toCodec === undefined
  ) {
    const identifier = ast.annotations?.identifier;
    throw new Error(
      `opaque declaration${
        typeof identifier === "string" ? ` '${identifier}'` : ""
      } has no toCodecJson/toCodec public wire projection`,
    );
  }
  switch (ast._tag) {
    case "Declaration":
      for (const child of ast.typeParameters) {
        assertRepresentableWireContract(child, seen);
      }
      break;
    case "Arrays":
      for (const child of [...ast.elements, ...ast.rest]) {
        assertRepresentableWireContract(child, seen);
      }
      break;
    case "Objects":
      for (const property of ast.propertySignatures) {
        assertRepresentableWireContract(property.type, seen);
      }
      for (const index of ast.indexSignatures) {
        assertRepresentableWireContract(index.parameter, seen);
        assertRepresentableWireContract(index.type, seen);
      }
      break;
    case "Union":
      for (const child of ast.types) {
        assertRepresentableWireContract(child, seen);
      }
      break;
    case "TemplateLiteral":
      for (const child of ast.parts) {
        assertRepresentableWireContract(child, seen);
      }
      break;
    case "Suspend":
      assertRepresentableWireContract(ast.thunk(), seen);
      break;
  }
};

const projectSchema = (schema: Schema.Top): InertSchemaProjection => {
  try {
    assertRepresentableWireContract(schema.ast);
    return freezeJson(
      Schema.toJsonSchemaDocument(schema) as unknown as InertSchemaProjection,
    );
  } catch (cause) {
    throw new Error(
      `schema public projection failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
};

const compileSchemaCodec = (schema: Schema.Top): DeployedSchemaCodec => {
  try {
    return Object.freeze({
      decode: Schema.decodeUnknownSync(schema as Schema.Decoder<unknown>),
      encode: Schema.encodeUnknownSync(schema as Schema.Encoder<unknown>),
    });
  } catch (cause) {
    throw new Error(
      `schema runtime codec compilation failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
};

/**
 * Capture metadata and compile runtime behavior synchronously from the same
 * deployed schema. The projection is never revived into an executable codec.
 */
export const bindDeployedSchema = (
  schema: Schema.Top,
): DeployedSchemaBinding => Object.freeze({
  projection: projectSchema(schema),
  codec: compileSchemaCodec(schema),
});
