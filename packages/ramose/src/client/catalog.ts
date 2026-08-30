import * as Effect from "effect/Effect";
import type { CatalogDefinition } from "../Catalog.ts";
import { compositionFromSchema } from "../db/composition.ts";
import { schemaTx } from "../db/ensure.ts";
import type { AnySchema } from "../db/Schema.ts";
import type { ReadCompatibilityHash } from "../internal/authorization/identities.ts";
import { hashReadCompatibility } from "../internal/authorization/read-compatibility.ts";
import {
  catalogReadTables,
  completeSchema,
} from "../internal/authorization/read-tables.ts";
import type { CompositionIndex } from "../internal/core/composition.ts";
import type { AttributeSpec } from "../internal/core/schema.ts";
import {
  makeClientProjectionCatalog,
  type ClientProjectionCatalog,
  type InstalledProjection,
} from "../internal/replication/projection-binding.ts";

const CARDINALITY: Record<string, "one" | "many"> = {
  ":db.cardinality/one": "one",
  ":db.cardinality/many": "many",
};

const UNIQUE: Record<string, "identity" | "value"> = {
  ":db.unique/identity": "identity",
  ":db.unique/value": "value",
};

const attributeSpecs = (schema: AnySchema): readonly AttributeSpec[] =>
  Object.freeze(schemaTx(schema).map((attribute): AttributeSpec => {
    const cardinality = CARDINALITY[attribute[":db/cardinality"]];
    if (cardinality === undefined) {
      throw new Error(
        `ramose/client: unknown cardinality for ${attribute[":db/ident"]}`,
      );
    }
    const unique = attribute[":db/unique"] === undefined
      ? undefined
      : UNIQUE[attribute[":db/unique"]];
    if (attribute[":db/unique"] !== undefined && unique === undefined) {
      throw new Error(
        `ramose/client: unknown uniqueness for ${attribute[":db/ident"]}`,
      );
    }
    return {
      ident: attribute[":db/ident"],
      valueType: attribute[":db/valueType"] as AttributeSpec["valueType"],
      cardinality,
      ...(unique === undefined ? {} : { unique }),
      index: attribute[":db/index"] === true,
      isComponent: attribute[":db/isComponent"] === true,
      optional: attribute[":db/optional"] === true,
    };
  }));

export type ClientCatalog = {
  readonly key: string;
  readonly schema: AnySchema;
  readonly attributes: readonly AttributeSpec[];
  readonly composition: CompositionIndex;
  readonly readCompatibilityHash: ReadCompatibilityHash;
  readonly projections: ClientProjectionCatalog;
};

export const installClientCatalog = async (
  definition: CatalogDefinition,
  projections: readonly InstalledProjection[] = [],
): Promise<ClientCatalog> => {
  const schema = completeSchema(definition);
  const readCompatibilityHash = await Effect.runPromise(
    hashReadCompatibility(catalogReadTables(definition)),
  );
  return Object.freeze({
    key: definition.key,
    schema,
    attributes: attributeSpecs(schema),
    composition: compositionFromSchema(schema),
    readCompatibilityHash,
    projections: makeClientProjectionCatalog(
      `${definition.key}:${readCompatibilityHash}`,
      projections,
    ),
  });
};
