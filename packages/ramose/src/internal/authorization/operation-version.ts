/**
 * The one operation-scoped compatibility version (#487).
 *
 * `OperationVersion` is the full SHA-256 of a single operation's canonical
 * descriptor. Every consumer that has to decide whether an invocation minted
 * earlier is still the same operation — offline queues, invocation receipts,
 * operation references — compares this value and nothing else.
 *
 * ## What the canonical descriptor covers
 *
 * - the semantic operation identity: catalog key, owner kind/name, local name;
 * - the target mode (`required` / `none`) — the public interaction shape;
 * - the normalized semantic input and output contracts: the declared schema
 *   representation plus the lowered Ramose shape;
 * - the public precondition and allocation behavior: the admissible composer
 *   entity names for a targeted trait operation, and the declared write
 *   entity names;
 * - the author-declared executable revision.
 *
 * ## What it must never cover
 *
 * Catalog unit hashes, deployment or build-artifact identity, executable
 * source, unrelated definitions in the same catalog, grants and policies,
 * documentation, graph paths and database instances, and wire projections or
 * aliases. Deployment binding stays a separate private fence: it may still
 * refuse to *execute*, but it never participates in the compatibility
 * decision. Excluding executable source is why the revision exists — bump
 * `revision` to rotate an operation whose declared contract is unchanged but
 * whose behavior is not.
 */

import * as Effect from "effect/Effect";
import type { OperationInputShape } from "./catalog.ts";
import { hashDomainSeparatedCanonicalJson } from "./decode.ts";
import {
  OperationVersion,
  type CatalogId,
  type OperationTarget,
  type OwnerRef,
} from "./identities.ts";
import type { JsonValue } from "./json.ts";

const OPERATION_VERSION_DOMAIN_V1 = "ramose/operation-version/v1\0";

/** Canonical descriptor generation. Bumping it rotates every version. */
export const OPERATION_VERSION_DESCRIPTOR_VERSION = 1 as const;

/** Revision assumed when an operation does not declare one. */
export const DEFAULT_OPERATION_REVISION = 1;

/** One declared semantic contract: the wire representation and lowered shape. */
export type OperationContractMaterial = {
  readonly representation: JsonValue;
  readonly shape: OperationInputShape;
};

/** Exactly the inputs the canonical operation descriptor is allowed to see. */
export type OperationVersionDescriptor = {
  readonly catalog: CatalogId;
  readonly owner: OwnerRef;
  readonly localName: string;
  readonly target: OperationTarget;
  readonly revision: number;
  readonly input: OperationContractMaterial;
  readonly output: OperationContractMaterial;
  /** Entity types admitted as the target of a trait operation. */
  readonly composers: readonly string[];
  /** Entity definitions this operation may allocate or write. */
  readonly writes: readonly string[];
};

/**
 * An author-declared revision must be an ordinary positive integer. It is the
 * only way to rotate an operation whose declared contract did not change.
 */
export const requireOperationRevision = (
  value: unknown,
  label: string,
): number => {
  if (value === undefined) return DEFAULT_OPERATION_REVISION;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(
      `ramose: ${label} revision must be a positive integer, not ${JSON.stringify(value)}`,
    );
  }
  return value;
};

const sortedNames = (names: readonly string[]): readonly string[] =>
  [...new Set(names)].sort();

/** JSON Schema keywords that carry documentation and no wire meaning. */
const DOCUMENTATION_KEYWORDS = new Set([
  "title",
  "description",
  "$comment",
  "examples",
]);
/** Keywords whose value is one subschema. */
const SUBSCHEMA_KEYWORDS = new Set([
  "additionalItems",
  "additionalProperties",
  "contains",
  "contentSchema",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
]);
/** Keywords whose value is an array of subschemas. */
const SUBSCHEMA_LIST_KEYWORDS = new Set([
  "allOf",
  "anyOf",
  "oneOf",
  "prefixItems",
]);
/** Keywords whose value maps author-chosen names to subschemas. */
const SUBSCHEMA_MAP_KEYWORDS = new Set([
  "$defs",
  "definitions",
  "dependentSchemas",
  "patternProperties",
  "properties",
]);

const isJsonObject = (value: unknown): value is Record<string, JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Drop documentation keywords from one JSON Schema node. Only positions that
 * are known to hold subschemas are descended into, so an author's property
 * *named* `description` is never mistaken for an annotation and an unknown
 * keyword is hashed verbatim. Removing documentation can never merge two
 * different contracts — it can only stop rotating on a doc-only edit.
 */
const stripSchemaDocumentation = (node: JsonValue): JsonValue => {
  if (Array.isArray(node)) return node.map(stripSchemaDocumentation);
  if (!isJsonObject(node)) return node;
  const out: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(node)) {
    if (DOCUMENTATION_KEYWORDS.has(key)) continue;
    if (SUBSCHEMA_KEYWORDS.has(key)) {
      out[key] = stripSchemaDocumentation(value);
    } else if (SUBSCHEMA_LIST_KEYWORDS.has(key) && Array.isArray(value)) {
      out[key] = value.map(stripSchemaDocumentation);
    } else if (SUBSCHEMA_MAP_KEYWORDS.has(key) && isJsonObject(value)) {
      out[key] = Object.fromEntries(
        Object.entries(value).map(([name, child]) => [
          name,
          stripSchemaDocumentation(child),
        ]),
      );
    } else {
      out[key] = value;
    }
  }
  return out;
};

/** JSON Pointer prefixes a deployed projection uses for its own definitions. */
const DEFINITION_REF_PREFIXES = ["#/$defs/", "#/definitions/"];
/** Canonical prefix every surviving internal reference is rewritten to. */
const CANONICAL_REF_PREFIX = "#/$defs/";

const definitionRefName = (
  value: JsonValue | undefined,
  names: ReadonlySet<string>,
): string | undefined => {
  if (typeof value !== "string") return undefined;
  for (const prefix of DEFINITION_REF_PREFIXES) {
    if (value.startsWith(prefix)) {
      const name = value.slice(prefix.length);
      if (names.has(name)) return name;
    }
  }
  return undefined;
};

/**
 * Order definition names by first reference, walking object keys sorted so
 * the order depends on structure alone. A name is recorded before its body is
 * entered, so a recursive definition terminates.
 */
const orderDefinitionNames = (
  node: JsonValue,
  definitions: Record<string, JsonValue>,
  names: ReadonlySet<string>,
  order: string[],
): void => {
  if (Array.isArray(node)) {
    for (const item of node) orderDefinitionNames(item, definitions, names, order);
    return;
  }
  if (!isJsonObject(node)) return;
  const referenced = definitionRefName(node.$ref, names);
  if (referenced !== undefined && !order.includes(referenced)) {
    order.push(referenced);
    orderDefinitionNames(definitions[referenced]!, definitions, names, order);
  }
  for (const key of Object.keys(node).sort()) {
    if (key === "$ref") continue;
    orderDefinitionNames(node[key]!, definitions, names, order);
  }
};

const rewriteDefinitionRefs = (
  node: JsonValue,
  names: ReadonlySet<string>,
  renamed: ReadonlyMap<string, string>,
): JsonValue => {
  if (Array.isArray(node)) {
    return node.map((item) => rewriteDefinitionRefs(item, names, renamed));
  }
  if (!isJsonObject(node)) return node;
  const out: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(node)) {
    const referenced = key === "$ref"
      ? definitionRefName(value, names)
      : undefined;
    out[key] = referenced === undefined
      ? rewriteDefinitionRefs(value, names, renamed)
      : `${CANONICAL_REF_PREFIX}${renamed.get(referenced)!}`;
  }
  return out;
};

/**
 * Replace the projection's definition names with positions in a structural
 * traversal. An Effect `identifier` annotation becomes the definition name and
 * the `$ref` that points at it, and renaming one is a wire alias change, not a
 * contract change — the compatibility contract excludes aliases, so the digest
 * must not see them. Renaming is a bijection, so two different contracts can
 * never be merged by it.
 */
const canonicalizeDefinitionNames = (
  document: Record<string, JsonValue>,
  mapKey: "definitions" | "$defs",
): Record<string, JsonValue> => {
  const definitions = document[mapKey] as Record<string, JsonValue>;
  const names = new Set(Object.keys(definitions));
  if (names.size === 0) return document;
  const order: string[] = [];
  orderDefinitionNames(document.schema!, definitions, names, order);
  // A definition nothing reaches still has to land somewhere deterministic.
  for (const name of [...names].sort()) {
    if (!order.includes(name)) order.push(name);
  }
  const renamed = new Map(order.map((name, index) => [name, `d${index}`]));
  return {
    ...document,
    schema: rewriteDefinitionRefs(document.schema!, names, renamed),
    [mapKey]: Object.fromEntries(order.map((name) => [
      renamed.get(name)!,
      rewriteDefinitionRefs(definitions[name]!, names, renamed),
    ])),
  };
};

/**
 * Normalize one declared contract representation for the version digest.
 *
 * The deployed projection is a JSON Schema document (`{ dialect, schema,
 * definitions }`). Two things in it are excluded from the compatibility
 * contract and are removed here: documentation, so an author's `description`
 * or `title` edit does not rotate the version, and wire aliases — an Effect
 * `identifier` annotation surfaces as the definition name and its `$ref`, and
 * renaming one is not a contract change. An unrecognized document shape is
 * hashed verbatim rather than guessed at.
 */
export const normalizeContractRepresentation = (
  representation: JsonValue,
): JsonValue => {
  if (!isJsonObject(representation) || representation.schema === undefined) {
    return representation;
  }
  const out: Record<string, JsonValue> = {};
  let mapKey: "definitions" | "$defs" | undefined;
  for (const [key, value] of Object.entries(representation)) {
    if (key === "schema") {
      out[key] = stripSchemaDocumentation(value);
    } else if (
      (key === "definitions" || key === "$defs") && isJsonObject(value)
    ) {
      if (mapKey === undefined) mapKey = key;
      out[key] = Object.fromEntries(
        Object.entries(value).map(([name, child]) => [
          name,
          stripSchemaDocumentation(child),
        ]),
      );
    } else {
      out[key] = value;
    }
  }
  return mapKey === undefined ? out : canonicalizeDefinitionNames(out, mapKey);
};

/**
 * Canonical, deployment-free operation material. Construction is the
 * enforcement: nothing outside {@link OperationVersionDescriptor} can reach
 * the digest.
 */
export const operationVersionMaterial = (
  descriptor: OperationVersionDescriptor,
): JsonValue => ({
  version: OPERATION_VERSION_DESCRIPTOR_VERSION,
  operation: {
    catalog: descriptor.catalog,
    owner: { kind: descriptor.owner.kind, name: descriptor.owner.name },
    localName: descriptor.localName,
    target: descriptor.target,
  },
  revision: descriptor.revision,
  contract: {
    input: {
      representation: normalizeContractRepresentation(
        descriptor.input.representation,
      ),
      shape: descriptor.input.shape as unknown as JsonValue,
    },
    output: {
      representation: normalizeContractRepresentation(
        descriptor.output.representation,
      ),
      shape: descriptor.output.shape as unknown as JsonValue,
    },
  },
  behavior: {
    composers: [...sortedNames(descriptor.composers)],
    writes: [...sortedNames(descriptor.writes)],
  },
});

/** Hash one canonical operation descriptor into its branded version. */
export const hashOperationVersion = Effect.fn("Authorization.hashOperationVersion")(
  function* (descriptor: OperationVersionDescriptor) {
    const digest = yield* hashDomainSeparatedCanonicalJson(
      OPERATION_VERSION_DOMAIN_V1,
      operationVersionMaterial(descriptor),
    );
    return OperationVersion.make(digest);
  },
);
