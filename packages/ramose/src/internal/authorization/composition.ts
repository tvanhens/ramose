/**
 * Type-to-trait lookup derived from a validated catalog descriptor or unit.
 *
 * Indexes are computed at the validation/assembly boundary and frozen.
 * They are not persisted as application datoms.
 */

import * as Result from "effect/Result";
import {
  makeCompositionIndex,
  type CompositionIndex,
} from "../core/composition.ts";
import type { CatalogDescriptor } from "./catalog.ts";
import type { InstalledCatalogUnitV2 } from "./catalog-unit.ts";
import { prepareAuthorizationCatalog, type PreparedAuthorizationCatalog } from "./validation/catalog.ts";
import type { ValidateFailure } from "./validation/common.ts";

const identOf = (name: string): string => `:${name}`;

const traitSetRows = (
  rows: ReadonlyMap<string, ReadonlySet<string>>,
): Array<readonly [string, readonly string[]]> => {
  const out: Array<readonly [string, readonly string[]]> = [];
  for (const [name, traits] of rows) {
    out.push([identOf(name), [...traits].map(identOf)]);
  }
  return out;
};

/** Freeze the prepared catalog's entity/trait closure as a lookup index. */
export const compositionFromPrepared = (
  index: PreparedAuthorizationCatalog,
): CompositionIndex =>
  makeCompositionIndex({
    entities: [...index.entities.keys()].map(identOf),
    traits: [...index.traits.keys()].map(identOf),
    entityTraits: traitSetRows(index.entityTraits),
    traitTraits: traitSetRows(index.traitTraits),
  });

/**
 * Derive composition from catalog tables. Direct edges are closed the same
 * way {@link prepareAuthorizationCatalog} already validated.
 */
export const compositionFromDescriptor = (
  descriptor: CatalogDescriptor,
): Result.Result<CompositionIndex, ValidateFailure> =>
  Result.gen(function* () {
    const prepared = yield* prepareAuthorizationCatalog(
      {
        database: descriptor.database,
        catalog: descriptor.id,
        catalogVersion: descriptor.version,
        schemaFingerprint: descriptor.fingerprint,
      },
      descriptor,
    );
    return compositionFromPrepared(prepared);
  });

/** Same lookup as {@link compositionFromDescriptor} for a sealed unit. */
export const compositionFromUnit = (
  unit: InstalledCatalogUnitV2,
): Result.Result<CompositionIndex, ValidateFailure> =>
  compositionFromDescriptor(unit.catalog);
