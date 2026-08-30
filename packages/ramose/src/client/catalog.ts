/**
 * The installed client catalog: everything a browser needs to build and query
 * one local `Db`, derived from the same authored definition the server deploys.
 *
 * The only value here that crosses the wire is
 * {@link ClientCatalog.readCompatibilityHash}, and it is deliberately derived
 * through the *shared* read-table walk rather than a client-side copy of it: a
 * second implementation would produce a hash that drifts silently, and every
 * activation would terminate `update-required` with nothing to point at.
 * Operations, policy, documentation, defaults, and deployment identity are all
 * excluded by that walk, so an operation-only or documentation-only change
 * keeps the same hash and the same reusable replica.
 */

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
} from "../internal/replication/projection-binding.ts";

const CARDINALITY: Record<string, "one" | "many"> = {
  ":db.cardinality/one": "one",
  ":db.cardinality/many": "many",
};

const UNIQUE: Record<string, "identity" | "value"> = {
  ":db.unique/identity": "identity",
  ":db.unique/value": "value",
};

/**
 * The local index schema, from the authored one.
 *
 * `schemaTx` is the same lowering the deploy path uses, so the local indexes
 * are built from the same field metadata the server enforces. Documentation is
 * dropped on the way in: a replica is documentation-free by construction, and
 * carrying it would make a documentation-only edit look like schema drift.
 */
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

/** One installed client catalog and build. */
export type ClientCatalog = {
  /** The catalog's permanent key, as authored. */
  readonly key: string;
  /** Every entity the definition reaches, including operation-reachable ones. */
  readonly schema: AnySchema;
  /** The local index schema. */
  readonly attributes: readonly AttributeSpec[];
  /** Deployed trait composition, bound to every committed value before it is queried. */
  readonly composition: CompositionIndex;
  /** Supplied on every activation; the server compares it before sending data. */
  readonly readCompatibilityHash: ReadCompatibilityHash;
  /**
   * The installed optimistic projections (#476).
   *
   * Empty until the catalog-derived mutation surface lands: an application
   * cannot enqueue an invocation through this slice's public API, so there is
   * no projection to install and no durable layer this build could author. A
   * layer some *other* build queued still resolves against this catalog and
   * quarantines as typed `update-required` rather than replaying code this
   * bundle does not contain.
   */
  readonly projections: ClientProjectionCatalog;
};

/**
 * Install one authored catalog for local use.
 *
 * Pure apart from the SHA-256, and idempotent: the same definition always
 * yields the same hash, on the client and on the server alike.
 */
export const installClientCatalog = async (
  definition: CatalogDefinition,
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
    // The build identity is the read-compatible shape of this bundle's catalog.
    // It is durable state, so it is derived rather than invented: the mutation
    // surface replaces it with the operation-derived bundle identity, and until
    // one exists there is nothing for a weaker value to mislabel.
    projections: makeClientProjectionCatalog(
      `${definition.key}:${readCompatibilityHash}`,
      [],
    ),
  });
};
