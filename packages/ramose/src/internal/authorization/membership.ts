/**
 * Canonical catalog identities for entity types and traits (ID-1–ID-5).
 *
 * Stored stamps stay `:ramose/type` / `:ramose/trait` with catalog-local
 * idents. This module maps that one representation onto {@link EntityId}
 * / {@link TraitId}. Wire-level derivation lives in
 * `internal/core/membership.ts`.
 *
 * @internal
 */

import * as Result from "effect/Result";
import type { CatalogDescriptor } from "./catalog.ts";
import { EntityId, TraitId, type CatalogId } from "./identities.ts";
import {
  composerIdent,
  deriveLocalMembership,
  localEntityName,
  sortIdents,
  type LocalMembership,
  MembershipStale,
} from "../core/membership.ts";
import {
  entityComposes,
  requireEntity,
  type PreparedAuthorizationCatalog,
} from "./validation/catalog.ts";

export {
  MembershipMissing,
  MembershipForged,
  MembershipContradictory,
  MembershipStale,
  OccupiedCompositionChange,
  decideMembership,
  deriveLocalMembership,
  fieldAllowedOn,
  fieldOwnerIdent,
  identListsEqual,
  membershipEqual,
  membershipFailureOf,
  occupiedCompositionFailure,
  sortIdents,
  composerIdent,
  localEntityName,
  type LocalMembership,
  type MembershipCatalogView,
  type MembershipDecision,
  type MembershipFailure,
  type MembershipWrite,
  type ObservedMembership,
} from "../core/membership.ts";

/** Catalog-scoped form of {@link LocalMembership}. */
export interface CanonicalMembership {
  readonly type: EntityId;
  readonly traits: readonly TraitId[];
}

export const toCanonicalMembership = (
  catalog: CatalogId,
  local: LocalMembership,
): CanonicalMembership => ({
  type: EntityId.make({ catalog, name: localEntityName(local.type) }),
  traits: local.traits.map((trait) =>
    TraitId.make({ catalog, name: localEntityName(trait) }),
  ),
});

export const fromCanonicalMembership = (
  membership: CanonicalMembership,
): LocalMembership => ({
  type: composerIdent(membership.type.name),
  traits: sortIdents(membership.traits.map((trait) => composerIdent(trait.name))),
});

export const deriveCanonicalMembership = (
  catalog: PreparedAuthorizationCatalog,
  entity: EntityId,
): Result.Result<CanonicalMembership, MembershipStale> =>
  Result.gen(function* () {
    const found = yield* requireEntity(
      catalog,
      entity,
      "membership entity",
    ).pipe(
      Result.mapError(
        () => new MembershipStale({ type: composerIdent(entity.name) }),
      ),
    );
    const traits = [...(catalog.entityTraits.get(entity.name) ?? [])]
      .filter((name) => entityComposes(catalog, found, name))
      .sort();
    return {
      type: found,
      traits: traits.map((name) =>
        TraitId.make({ catalog: found.catalog, name }),
      ),
    };
  });

export const deriveDescriptorMembership = (
  descriptor: CatalogDescriptor,
  entity: EntityId,
): Result.Result<CanonicalMembership, MembershipStale> => {
  const stale = (): Result.Result<CanonicalMembership, MembershipStale> =>
    Result.fail(new MembershipStale({ type: composerIdent(entity.name) }));
  if (entity.catalog !== descriptor.id) return stale();
  const entities = descriptor.entities.filter((item) => item.id.catalog === descriptor.id);
  const traits = descriptor.traits.filter((item) => item.id.catalog === descriptor.id);
  const row = entities.find((item) => item.id.name === entity.name);
  if (row === undefined) return stale();

  let foreign = false;
  const mark = (id: { readonly catalog: CatalogId }): boolean => {
    if (id.catalog === descriptor.id) return false;
    foreign = true;
    return true;
  };
  const byName = new Map(traits.map((trait) => [trait.id.name, trait]));
  const visit = (traitId: TraitId): void => {
    if (mark(traitId)) return;
    const nested = byName.get(traitId.name);
    if (nested === undefined) return;
    for (const child of nested.traits) visit(child);
  };
  for (const trait of row.traits) visit(trait);
  if (foreign) return stale();

  return deriveLocalMembership(
    {
      isEntityIdent: (ident) =>
        entities.some((item) => composerIdent(item.id.name) === ident),
      isTraitIdent: (ident) =>
        traits.some((item) => composerIdent(item.id.name) === ident),
      transitiveTraits: (ident) => {
        const name = localEntityName(ident);
        const seen = new Set<string>();
        const walk = (traitName: string): void => {
          if (seen.has(traitName)) return;
          seen.add(traitName);
          const nested = byName.get(traitName);
          if (nested === undefined) return;
          for (const child of nested.traits) {
            if (mark(child)) continue;
            walk(child.name);
          }
        };
        const entityRow = entities.find((item) => item.id.name === name);
        if (entityRow !== undefined) {
          for (const trait of entityRow.traits) {
            if (mark(trait)) continue;
            walk(trait.name);
          }
        }
        return sortIdents([...seen].map((traitName) => composerIdent(traitName)));
      },
      composesOf: (ident) => {
        const name = localEntityName(ident);
        const entityRow = entities.find((item) => item.id.name === name);
        if (entityRow !== undefined) {
          return entityRow.traits.flatMap((trait) =>
            trait.catalog === descriptor.id ? [composerIdent(trait.name)] : [],
          );
        }
        const traitRow = traits.find((item) => item.id.name === name);
        return (
          traitRow?.traits.flatMap((trait) =>
            trait.catalog === descriptor.id ? [composerIdent(trait.name)] : [],
          ) ?? []
        );
      },
    },
    composerIdent(entity.name),
  ).pipe(
    Result.flatMap((local) =>
      foreign ? stale() : Result.succeed(toCanonicalMembership(descriptor.id, local)),
    ),
  );
};
