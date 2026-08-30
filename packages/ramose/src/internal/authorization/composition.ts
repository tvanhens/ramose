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

export const compositionFromPrepared = (
  index: PreparedAuthorizationCatalog,
): CompositionIndex =>
  makeCompositionIndex({
    entities: [...index.entities.keys()].map(identOf),
    traits: [...index.traits.keys()].map(identOf),
    entityTraits: traitSetRows(index.entityTraits),
    traitTraits: traitSetRows(index.traitTraits),
  });

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

export const compositionFromUnit = (
  unit: InstalledCatalogUnitV2,
): Result.Result<CompositionIndex, ValidateFailure> =>
  compositionFromDescriptor(unit.catalog);
