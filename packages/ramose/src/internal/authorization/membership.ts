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
  if (entity.catalog !== descriptor.id) {
    return Result.fail(new MembershipStale({ type: composerIdent(entity.name) }));
  }
  const row = descriptor.entities.find(
    (item) => item.id.catalog === entity.catalog && item.id.name === entity.name,
  );
  if (row === undefined) {
    return Result.fail(new MembershipStale({ type: composerIdent(entity.name) }));
  }
  return deriveLocalMembership(
    {
      isEntityIdent: (ident) =>
        descriptor.entities.some((item) => composerIdent(item.id.name) === ident),
      isTraitIdent: (ident) =>
        descriptor.traits.some((item) => composerIdent(item.id.name) === ident),
      transitiveTraits: (ident) => {
        const name = localEntityName(ident);
        const traits = new Set<string>();
        const byName = new Map(descriptor.traits.map((trait) => [trait.id.name, trait]));
        const visit = (traitName: string): void => {
          if (traits.has(traitName)) return;
          traits.add(traitName);
          const nested = byName.get(traitName);
          if (nested === undefined) return;
          for (const child of nested.traits) visit(child.name);
        };
        const entityRow = descriptor.entities.find((item) => item.id.name === name);
        if (entityRow !== undefined) {
          for (const trait of entityRow.traits) visit(trait.name);
        }
        return sortIdents([...traits].map((traitName) => composerIdent(traitName)));
      },
      composesOf: (ident) => {
        const name = localEntityName(ident);
        const entityRow = descriptor.entities.find((item) => item.id.name === name);
        if (entityRow !== undefined) {
          return entityRow.traits.map((trait) => composerIdent(trait.name));
        }
        const traitRow = descriptor.traits.find((item) => item.id.name === name);
        return traitRow?.traits.map((trait) => composerIdent(trait.name)) ?? [];
      },
    },
    composerIdent(entity.name),
  ).pipe(Result.map((local) => toCanonicalMembership(descriptor.id, local)));
};
