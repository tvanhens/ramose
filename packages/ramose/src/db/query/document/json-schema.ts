/**
 * The canonical JSON Schema (2020-12) for `QueryDocumentV1`.
 *
 * This is the published contract other surfaces `$ref` — a wire envelope,
 * a code generator, a client written in another language. It is a plain
 * value with no dependency on any transport, and it is authored beside the
 * TypeScript types and the validator so all three describe one grammar.
 *
 * The schema is structural: it rejects malformed documents (two expression
 * tags on one node, a dotted field path, an unknown member) and says
 * nothing about which entities, fields, or functions exist — those resolve
 * through the catalog and function registry at compile time, where the
 * caller's visibility decides the answer.
 */

import { QUERY_DOCUMENT_SCHEMA_ID, QUERY_DOCUMENT_VERSION } from "./types.ts";

const NAME_PATTERN = "^[A-Za-z_][A-Za-z0-9_]*$";

/**
 * The value encoding, stated in the published schema so a client in
 * another language reads it from the contract rather than from this repo.
 */
const VALUE_ENCODING =
  'Plain JSON. Values JSON cannot carry natively use Ramose\'s canonical encoding: { "$inst": <epoch milliseconds, or an ISO-8601 string> }, { "$uuid": "<uuid>" }, { "$bytes": "<base64>" }. An entity id is a plain number. Every other "$"-prefixed object key is reserved and refused, so a future tagged encoding is additive rather than a reinterpretation of documents already accepted.';

export const queryDocumentJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: QUERY_DOCUMENT_SCHEMA_ID,
  title: "QueryDocumentV1",
  description:
    "A versioned, plain-data query document. Field paths are arrays of field names; every expression node carries exactly one tag; bindings are ordered.",
  type: "object",
  additionalProperties: false,
  required: ["version", "from"],
  properties: {
    version: { const: QUERY_DOCUMENT_VERSION },
    from: { $ref: "#/$defs/root" },
    params: { $ref: "#/$defs/params" },
    let: { type: "array", items: { $ref: "#/$defs/binding" } },
    // `null` is accepted wherever the normalized document writes an
    // explicit absence, so a normalized document validates against the
    // same schema its input did.
    where: { oneOf: [{ $ref: "#/$defs/expression" }, { type: "null" }] },
    select: { oneOf: [{ $ref: "#/$defs/projection" }, { type: "null" }] },
    orderBy: { type: "array", items: { $ref: "#/$defs/order" } },
    page: { $ref: "#/$defs/page" },
    cardinality: { enum: ["one", "many"] },
  },
  $defs: {
    root: {
      description: "The scan root: one entity type, or one trait.",
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["entity"],
          properties: { entity: { type: "string", minLength: 1 } },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["trait"],
          properties: { trait: { type: "string", minLength: 1 } },
        },
      ],
    },
    params: {
      description: `Plain-data query parameters, referenced by { param }. ${VALUE_ENCODING}`,
      type: "object",
      propertyNames: { pattern: NAME_PATTERN },
      additionalProperties: true,
    },
    fieldPath: {
      description: "A field path as an array of field names — never a dotted string.",
      type: "array",
      minItems: 1,
      items: { type: "string", minLength: 1 },
    },
    expression: {
      description:
        "One expression node with exactly one tag. Comparisons and boolean connectives are ordinary calls resolved through the function registry.",
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["field"],
          properties: { field: { $ref: "#/$defs/fieldPath" } },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["value"],
          properties: { value: { description: VALUE_ENCODING } },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["param"],
          properties: { param: { type: "string", pattern: NAME_PATTERN } },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["var"],
          properties: { var: { type: "string", pattern: NAME_PATTERN } },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["call", "args"],
          properties: {
            call: { type: "string", minLength: 1 },
            args: { type: "array", items: { $ref: "#/$defs/expression" } },
          },
        },
      ],
    },
    binding: {
      description: "One ordered let binding. Later bindings see earlier ones.",
      type: "object",
      additionalProperties: false,
      required: ["as", "expr"],
      properties: {
        as: { type: "string", pattern: NAME_PATTERN },
        expr: { $ref: "#/$defs/expression" },
      },
    },
    projection: {
      description: "Projected columns: an expression, or a nested relation projection.",
      type: "object",
      minProperties: 1,
      propertyNames: { pattern: NAME_PATTERN },
      additionalProperties: { $ref: "#/$defs/selection" },
    },
    selection: {
      oneOf: [{ $ref: "#/$defs/expression" }, { $ref: "#/$defs/nested" }],
    },
    nested: {
      description: "A nested projection across one reference hop.",
      type: "object",
      additionalProperties: false,
      required: ["path", "select"],
      properties: {
        path: { $ref: "#/$defs/fieldPath" },
        select: { $ref: "#/$defs/projection" },
      },
    },
    order: {
      description:
        "One sort key: a { field } path or a { var } naming a binding. Bind a computed key in let first.",
      type: "object",
      additionalProperties: false,
      required: ["expr"],
      properties: {
        expr: { $ref: "#/$defs/expression" },
        direction: { enum: ["asc", "desc"] },
        empty: { enum: ["first", "last"] },
      },
    },
    page: {
      description:
        "Page bounds. `after` is an opaque cursor; it and `offset` are mutually exclusive.",
      type: "object",
      additionalProperties: false,
      properties: {
        first: { type: ["integer", "null"], minimum: 1 },
        after: { type: ["string", "null"], minLength: 1 },
        offset: { type: ["integer", "null"], minimum: 0 },
      },
    },
  },
} as const;

export type QueryDocumentJsonSchema = typeof queryDocumentJsonSchema;
