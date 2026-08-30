import * as Effect from "effect/Effect";
import type { AllocationSlots } from "../../db/allocations.ts";
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

export const OPERATION_VERSION_DESCRIPTOR_VERSION = 2 as const;

export const DEFAULT_OPERATION_REVISION = 1;

export type OperationContractMaterial = {
  readonly representation: JsonValue;
  readonly shape: OperationInputShape;
};

export type OperationVersionDescriptor = {
  readonly catalog: CatalogId;
  readonly owner: OwnerRef;
  readonly localName: string;
  readonly target: OperationTarget;
  readonly revision: number;
  readonly input: OperationContractMaterial;
  readonly output: OperationContractMaterial;
  readonly composers: readonly string[];
  readonly writes: readonly string[];
  readonly allocations: AllocationSlots;
};

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

const DOCUMENTATION_KEYWORDS = new Set([
  "title",
  "description",
  "$comment",
  "examples",
]);
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
const SUBSCHEMA_LIST_KEYWORDS = new Set([
  "allOf",
  "anyOf",
  "oneOf",
  "prefixItems",
]);
const SUBSCHEMA_MAP_KEYWORDS = new Set([
  "$defs",
  "definitions",
  "dependentSchemas",
  "patternProperties",
  "properties",
]);

const isJsonObject = (value: unknown): value is Record<string, JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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

const DEFINITION_REF_PREFIXES = ["#/$defs/", "#/definitions/"];
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

const canonicalizeDefinitionNames = (
  document: Record<string, JsonValue>,
  mapKey: "definitions" | "$defs",
): Record<string, JsonValue> => {
  const definitions = document[mapKey] as Record<string, JsonValue>;
  const names = new Set(Object.keys(definitions));
  if (names.size === 0) return document;
  const order: string[] = [];
  orderDefinitionNames(document.schema!, definitions, names, order);
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
    allocations: [...descriptor.allocations]
      .sort((left, right) => (left.slot < right.slot ? -1 : left.slot > right.slot ? 1 : 0))
      .map((allocation) => ({
        slot: allocation.slot,
        path: [...allocation.path],
      })),
  },
});

export const hashOperationVersion = Effect.fn("Authorization.hashOperationVersion")(
  function* (descriptor: OperationVersionDescriptor) {
    const digest = yield* hashDomainSeparatedCanonicalJson(
      OPERATION_VERSION_DOMAIN_V1,
      operationVersionMaterial(descriptor),
    );
    return OperationVersion.make(digest);
  },
);
