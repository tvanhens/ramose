/**
 * The JSON Schema 2020-12 surface of the contract (#485).
 *
 * Two representations exist and they are not interchangeable.
 *
 * - A **document** — `{ dialect, schema, definitions }` — is what the engine's
 *   deployed schema projection already produces for every operation contract
 *   (`db/deployedSchema.ts`). Keeping that shape means an operation card
 *   carries the *same* inert projection the engine bound at deploy time; there
 *   is no second rendering of an author's schema and therefore nothing to
 *   drift.
 * - A **root schema** is a single self-contained JSON Schema 2020-12 object
 *   with `$schema` and `$defs` inlined. That is what MCP tool definitions and
 *   `structuredContent` validators consume.
 *
 * {@link toRootJsonSchema} is the one conversion between them, and it is a
 * pure rearrangement: no keyword is added, removed, or reinterpreted beyond
 * moving `definitions` into `$defs` and stamping the dialect.
 */

import * as Schema from "effect/Schema";
import { JsonValueV1 } from "./primitives.ts";

/** The one dialect. Every schema this contract publishes is 2020-12. */
export const JSON_SCHEMA_DIALECT = "draft-2020-12" as const;

/** Canonical `$schema` value for {@link JSON_SCHEMA_DIALECT}. */
export const JSON_SCHEMA_DIALECT_URI =
  "https://json-schema.org/draft/2020-12/schema" as const;

/**
 * Any JSON Schema node. Open by construction: JSON Schema is extensible.
 *
 * Deliberately unnamed. It appears at several places that mean genuinely
 * different things — a field's value schema, an operation's input, an
 * operation's output — and each of those deserves its own description. A
 * shared `$defs` entry can carry only one.
 */
export const JsonSchemaV1 = Schema.Record(Schema.String, JsonValueV1);
export type JsonSchemaV1 = { readonly [key: string]: unknown };

/** A root schema plus its shared definitions, as the engine projects them. */
export type JsonSchemaDocumentV1 = {
  readonly dialect: typeof JSON_SCHEMA_DIALECT;
  readonly schema: JsonSchemaV1;
  readonly definitions: { readonly [name: string]: JsonSchemaV1 };
};

const isJsonObject = (value: unknown): value is { [key: string]: unknown } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Recognize an engine schema projection. A projection whose dialect is not
 * 2020-12, or whose root is not an object, is not publishable: the contract
 * refuses it rather than shipping a schema a client cannot evaluate.
 */
export const isJsonSchemaDocument = (
  value: unknown,
): value is JsonSchemaDocumentV1 =>
  isJsonObject(value) && value.dialect === JSON_SCHEMA_DIALECT &&
  isJsonObject(value.schema) &&
  (value.definitions === undefined || isJsonObject(value.definitions));

const DEFS_PREFIX = "#/$defs/";

/**
 * A `$defs` entry that is nothing but `{"$ref": "#/$defs/Other"}`.
 *
 * Recursive schemas produce these: the recursion point becomes its own
 * definition that only forwards to the real one. They are semantically inert
 * and their names are generator-invented, so they are collapsed away before
 * publication rather than frozen into the contract.
 */
const aliasTarget = (node: unknown): string | undefined => {
  if (!isJsonObject(node)) return undefined;
  const keys = Object.keys(node);
  if (keys.length !== 1 || keys[0] !== "$ref") return undefined;
  const ref = node.$ref;
  return typeof ref === "string" && ref.startsWith(DEFS_PREFIX)
    ? ref.slice(DEFS_PREFIX.length)
    : undefined;
};

const rewriteRefs = (
  node: unknown,
  aliases: ReadonlyMap<string, string>,
): unknown => {
  if (Array.isArray(node)) return node.map((child) => rewriteRefs(child, aliases));
  if (!isJsonObject(node)) return node;
  const out: { [key: string]: unknown } = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "$ref" && typeof value === "string") {
      const name = value.startsWith(DEFS_PREFIX)
        ? value.slice(DEFS_PREFIX.length)
        : undefined;
      const resolved = name === undefined ? undefined : aliases.get(name);
      out[key] = resolved === undefined ? value : `${DEFS_PREFIX}${resolved}`;
      continue;
    }
    out[key] = rewriteRefs(value, aliases);
  }
  return out;
};

/**
 * Every published `$defs` name must look like a contract type: an identifier
 * this module deliberately chose, ending in its version.
 *
 * This is the guard that keeps generator-invented names — `Union_`,
 * `Suspend_`, and the `_1` / `_2` suffixes that appear when one identified
 * schema is re-annotated at two call sites — out of a frozen contract. Such a
 * name is a wire alias nobody chose and whose numbering could shift on the
 * next regeneration, so it is a build failure rather than a published name.
 */
const PUBLISHED_DEFINITION_NAME = /^[A-Z][A-Za-z0-9]*V1$/;

/**
 * Flatten a document into one self-contained JSON Schema 2020-12 root.
 *
 * The result is what a tool definition and a `structuredContent` validator
 * consume. `$defs` is emitted only when the document actually has
 * definitions, so a simple schema stays simple.
 */
export const toRootJsonSchema = (
  document: JsonSchemaDocumentV1,
): JsonSchemaV1 => {
  if (!isJsonSchemaDocument(document)) {
    throw new TypeError(
      "ramose/mcp: only a draft-2020-12 schema document can be published",
    );
  }
  const definitions = document.definitions ?? {};

  // Collapse alias definitions, following chains to the first real definition.
  const aliases = new Map<string, string>();
  for (const name of Object.keys(definitions)) {
    let target = aliasTarget(definitions[name]);
    if (target === undefined) continue;
    const seen = new Set([name]);
    for (;;) {
      const next = aliasTarget(definitions[target!]);
      if (next === undefined || seen.has(next)) break;
      seen.add(target!);
      target = next;
    }
    aliases.set(name, target!);
  }

  const kept: { [name: string]: JsonSchemaV1 } = {};
  for (const [name, definition] of Object.entries(definitions)) {
    if (aliases.has(name)) continue;
    if (!PUBLISHED_DEFINITION_NAME.test(name)) {
      throw new TypeError(
        `ramose/mcp: "${name}" is a generated schema name, not a contract type. Give the schema an identifier, or stop re-annotating an already-identified one.`,
      );
    }
    kept[name] = rewriteRefs(definition, aliases) as JsonSchemaV1;
  }

  const hasDefinitions = Object.keys(kept).length > 0;
  return Object.freeze({
    $schema: JSON_SCHEMA_DIALECT_URI,
    ...(rewriteRefs(document.schema, aliases) as JsonSchemaV1),
    ...(hasDefinitions ? { $defs: Object.freeze(kept) } : {}),
  });
};

/**
 * Render one contract schema as a publishable root schema.
 *
 * Descriptions are the ones this contract wrote, never generated ones. An
 * agent reading a tool schema has nothing else to go on, and "a value with a
 * length of at least 1" tells it nothing a `minLength` keyword did not; worse,
 * per-constraint generated prose splits an otherwise flat node into nested
 * `allOf` fragments, which is harder for a client to read and harder to diff
 * when {@link ../compatibility.ts} classifies a change.
 */
export const rootJsonSchemaOf = (schema: Schema.Top): JsonSchemaV1 =>
  toRootJsonSchema(
    Schema.toJsonSchemaDocument(schema) as unknown as JsonSchemaDocumentV1,
  );

/**
 * Render one contract schema as a publishable root, with the object root the
 * MCP Tool wire shape requires.
 *
 * MCP says a tool's `inputSchema` and `outputSchema` are each an object schema
 * — literally `type: "object"` at the root. An input schema gets that for free
 * because it is a struct. A *result* is a union, and Effect emits a union as a
 * bare `anyOf` with no root type, which a conformant validator rejects: the
 * tool definition would be refused before any call could be made.
 *
 * Adding the root type is semantically a no-op here and this proves it rather
 * than assuming it. Every arm is resolved through `$defs` and checked to be
 * object-typed; only then is `type: "object"` added, so the published schema
 * still admits exactly the same documents. A union that ever gains a non-object
 * arm fails the build instead of silently publishing a root type that would
 * exclude it.
 */
export const objectRootJsonSchemaOf = (
  schema: Schema.Top,
  label: string,
): JsonSchemaV1 => {
  const root = rootJsonSchemaOf(schema);
  if (root.type === "object") return root;
  if (root.type !== undefined) {
    throw new TypeError(
      `ramose/mcp: ${label} must have an object root, not ${String(root.type)}`,
    );
  }

  const defs = isJsonObject(root.$defs) ? root.$defs : {};
  const resolve = (node: unknown): unknown => {
    if (!isJsonObject(node)) return node;
    const ref = node.$ref;
    if (typeof ref !== "string" || !ref.startsWith(DEFS_PREFIX)) return node;
    return defs[ref.slice(DEFS_PREFIX.length)];
  };

  const arms = root.anyOf ?? root.oneOf;
  if (!Array.isArray(arms) || arms.length === 0) {
    throw new TypeError(
      `ramose/mcp: ${label} has neither an object root nor a union to derive one from`,
    );
  }
  for (const arm of arms) {
    const resolved = resolve(arm);
    if (!isJsonObject(resolved) || resolved.type !== "object") {
      throw new TypeError(
        `ramose/mcp: ${label} has a union arm that is not an object, so an object root would change its meaning`,
      );
    }
  }
  return Object.freeze({ type: "object", ...root });
};

/**
 * MCP reserves these argument names for multi-round-trip retries. An
 * application schema that defined either would be silently rewritten by the
 * protocol, so the contract refuses them outright — see
 * {@link assertNoReservedArgumentNames}.
 */
export const RESERVED_MRTR_ARGUMENT_NAMES = Object.freeze(
  ["requestState", "inputResponses"] as const,
);

/**
 * Refuse a schema that declares a reserved MRTR argument name anywhere in its
 * `properties`. Applied to every published tool schema and to every operation
 * card's input schema, because a card carries an application author's schema
 * that this contract never wrote.
 */
export const assertNoReservedArgumentNames = (
  schema: unknown,
  label: string,
): void => {
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (!isJsonObject(node)) return;
    const properties = node.properties;
    if (isJsonObject(properties)) {
      for (const reserved of RESERVED_MRTR_ARGUMENT_NAMES) {
        if (Object.hasOwn(properties, reserved)) {
          throw new TypeError(
            `ramose/mcp: ${label} declares the reserved MCP argument name "${reserved}"`,
          );
        }
      }
    }
    for (const child of Object.values(node)) visit(child);
  };
  visit(schema);
};
