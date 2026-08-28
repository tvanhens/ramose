/**
 * Derive a {@link CompositionIndex} from the TypeScript schema surface.
 *
 * This is the same descriptor-level walk Entity / Trait already do — not a
 * second membership store and not database-resident composition metadata.
 */

import {
  composerIdent,
  reachableTraits,
  transitiveTraitIdents,
  type ComposerLike,
} from "./compose.ts";
import { makeCompositionIndex, type CompositionIndex } from "../internal/core/composition.ts";
import type { AnySchema } from "./Schema.ts";

/** Type-to-trait lookup for the composers in `schema`. */
export const compositionFromSchema = (schema: AnySchema): CompositionIndex => {
  const entities = Object.values(schema.entities);
  const traits = reachableTraits(entities as ComposerLike[]);
  const entityTraits: Array<readonly [string, readonly string[]]> = [];
  for (const entity of entities) {
    entityTraits.push([
      composerIdent(entity.ns),
      transitiveTraitIdents(entity as ComposerLike),
    ]);
  }
  const traitTraits: Array<readonly [string, readonly string[]]> = [];
  for (const [ns, trait] of traits) {
    traitTraits.push([composerIdent(ns), transitiveTraitIdents(trait)]);
  }
  return makeCompositionIndex({
    entities: entities.map((entity) => composerIdent(entity.ns)),
    traits: [...traits.keys()].map((ns) => composerIdent(ns)),
    entityTraits,
    traitTraits,
  });
};
