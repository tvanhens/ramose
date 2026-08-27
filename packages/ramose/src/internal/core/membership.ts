/**
 * Engine-owned local membership stamps (`:ramose/type`, `:ramose/trait`).
 *
 * Closure derivation and comparison are pure. Catalog-scoped identities
 * live in `internal/authorization/membership.ts`.
 *
 * @internal
 */

import * as Data from "effect/Data";
import * as Result from "effect/Result";

/** Installed catalog view the transactor already has (`db.schema`). */
export interface MembershipCatalogView {
  readonly isEntityIdent: (ident: string) => boolean;
  readonly isTraitIdent: (ident: string) => boolean;
  readonly transitiveTraits: (ident: string) => readonly string[];
  readonly composesOf: (ident: string) => readonly string[];
}

/**
 * Engine-owned membership for one application entity, as stored.
 * `traits` is the full transitive closure, diamonds collapsed, sorted.
 */
export interface LocalMembership {
  readonly type: string;
  readonly traits: readonly string[];
}

/** What a write presented for membership — never inferred from fields. */
export interface ObservedMembership {
  readonly types: readonly string[];
  readonly traits: readonly string[];
}

export class MembershipMissing extends Data.TaggedError("MembershipMissing")<{
  readonly entity?: number;
}> {}

export class MembershipForged extends Data.TaggedError("MembershipForged")<{
  readonly entity?: number;
}> {}

export class MembershipContradictory extends Data.TaggedError("MembershipContradictory")<{
  readonly entity?: number;
  readonly expected?: LocalMembership;
  readonly actual?: ObservedMembership;
}> {}

export class MembershipStale extends Data.TaggedError("MembershipStale")<{
  readonly entity?: number;
  readonly type?: string;
}> {}

export class OccupiedCompositionChange extends Data.TaggedError(
  "OccupiedCompositionChange",
)<{
  readonly type: string;
  readonly before: readonly string[];
  readonly after: readonly string[];
}> {}

export type MembershipFailure =
  | MembershipMissing
  | MembershipForged
  | MembershipContradictory
  | MembershipStale
  | OccupiedCompositionChange;

export type MembershipDecision =
  | { readonly _tag: "ok"; readonly expected: LocalMembership }
  | { readonly _tag: "missing" }
  | { readonly _tag: "forged" }
  | { readonly _tag: "contradictory"; readonly expected?: LocalMembership }
  | { readonly _tag: "stale"; readonly type?: string };

/** `:issue/title` → `:issue`; `:issue` → `:issue`. System idents → `undefined`. */
export const fieldOwnerIdent = (ident: string): string | undefined => {
  if (ident.startsWith(":db/") || ident.startsWith(":ramose/")) return undefined;
  if (!ident.startsWith(":") || ident.length < 2) return undefined;
  const slash = ident.indexOf("/", 1);
  return slash > 1 ? `:${ident.slice(1, slash)}` : ident;
};

export const composerIdent = (nsOrIdent: string): string =>
  nsOrIdent.startsWith(":") ? nsOrIdent : `:${nsOrIdent}`;

export const localEntityName = (ident: string): string =>
  ident.startsWith(":") ? ident.slice(1) : ident;

export const sortIdents = (idents: readonly string[]): readonly string[] =>
  [...new Set(idents)].sort();

export const identListsEqual = (
  left: readonly string[],
  right: readonly string[],
): boolean => {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return false;
  }
  return true;
};

export const membershipEqual = (
  left: LocalMembership,
  right: LocalMembership,
): boolean =>
  left.type === right.type && identListsEqual(left.traits, right.traits);

export const deriveLocalMembership = (
  catalog: MembershipCatalogView,
  typeIdent: string,
): Result.Result<LocalMembership, MembershipStale> => {
  if (!catalog.isEntityIdent(typeIdent)) {
    return Result.fail(new MembershipStale({ type: typeIdent }));
  }
  return Result.succeed({
    type: typeIdent,
    traits: sortIdents(catalog.transitiveTraits(typeIdent)),
  });
};

export const fieldAllowedOn = (
  catalog: MembershipCatalogView,
  typeIdent: string,
  fieldIdent: string,
): boolean => {
  const owner = fieldOwnerIdent(fieldIdent);
  if (owner === undefined) return true;
  if (owner === typeIdent) return true;
  return catalog.transitiveTraits(typeIdent).includes(owner);
};

export interface MembershipWrite {
  readonly observed: ObservedMembership;
  readonly existingType: string | undefined;
  readonly isCreate: boolean;
  readonly clientWroteType: boolean;
  readonly clientWroteTraits: boolean;
}

/**
 * Decide the authoritative membership for one application entity.
 * Callers must not pass field prefixes or attribute presence as `observed`.
 */
export const decideMembership = (
  catalog: MembershipCatalogView,
  write: MembershipWrite,
): MembershipDecision => {
  if (write.clientWroteTraits) return { _tag: "forged" };
  if (write.observed.types.length > 1) {
    return { _tag: "contradictory" };
  }
  if (
    !write.isCreate &&
    write.clientWroteType &&
    write.observed.types[0] !== write.existingType
  ) {
    return { _tag: "forged" };
  }

  const declared = write.observed.types[0];
  if (write.isCreate) {
    if (declared === undefined) return { _tag: "missing" };
    const expected = deriveLocalMembership(catalog, declared);
    if (Result.isFailure(expected)) {
      return { _tag: "stale", type: declared };
    }
    if (
      write.observed.traits.length > 0 &&
      !identListsEqual(write.observed.traits, expected.success.traits)
    ) {
      return { _tag: "forged" };
    }
    return { _tag: "ok", expected: expected.success };
  }

  if (write.existingType === undefined) return { _tag: "missing" };
  if (declared !== undefined && declared !== write.existingType) {
    return { _tag: "contradictory" };
  }
  const expected = deriveLocalMembership(catalog, write.existingType);
  if (Result.isFailure(expected)) {
    return { _tag: "stale", type: write.existingType };
  }
  if (!identListsEqual(sortIdents(write.observed.traits), expected.success.traits)) {
    return {
      _tag: "contradictory",
      expected: expected.success,
    };
  }
  return { _tag: "ok", expected: expected.success };
};

export const membershipFailureOf = (
  decision: Exclude<MembershipDecision, { readonly _tag: "ok" }>,
  entity?: number,
  actual?: ObservedMembership,
): MembershipFailure => {
  switch (decision._tag) {
    case "missing":
      return new MembershipMissing(entity === undefined ? {} : { entity });
    case "forged":
      return new MembershipForged(entity === undefined ? {} : { entity });
    case "contradictory":
      return new MembershipContradictory({
        ...(entity === undefined ? {} : { entity }),
        ...(decision.expected !== undefined && { expected: decision.expected }),
        ...(actual !== undefined && { actual }),
      });
    case "stale":
      return new MembershipStale({
        ...(entity === undefined ? {} : { entity }),
        ...(decision.type === undefined ? {} : { type: decision.type }),
      });
  }
};

export const occupiedCompositionFailure = (
  type: string,
  before: readonly string[],
  after: readonly string[],
): OccupiedCompositionChange =>
  new OccupiedCompositionChange({
    type,
    before: sortIdents(before),
    after: sortIdents(after),
  });
