/**
 * Trait composition: flatten, diamonds, cycles, collisions.
 *
 * Structural — Entity and Trait both satisfy {@link ComposerLike}. Kept
 * out of those modules so they do not import each other at runtime.
 */

import { conflictingIdent } from "./IdentName.ts";

export type ComposerLike = {
  readonly ns: string;
  readonly fields: object;
  readonly traits?: readonly ComposerLike[];
};

/** Runtime composition list. Not on the Entity type — keeps Entity assignable. */
export const traitsOf = (composer: unknown): readonly ComposerLike[] => {
  if (typeof composer !== "object" || composer === null) return [];
  const traits = (composer as { readonly traits?: unknown }).traits;
  return Array.isArray(traits) ? (traits as readonly ComposerLike[]) : [];
};

export const composerIdent = (ns: string): `:${string}` => `:${ns}`;

export const fieldIdentOf = (
  field: { readonly ident?: unknown },
  key: string,
): string => (typeof field.ident === "string" ? field.ident : key);

export const conflictingFieldName = (
  key: string,
  left: string,
  right: string,
): Error =>
  new Error(
    `ramose/schema: conflicting field ${JSON.stringify(key)} — ${left} vs ${right}`,
  );

export const traitCycle = (path: readonly string[]): Error =>
  new Error(`ramose/schema: trait cycle: ${path.join(" → ")}`);

export const duplicateTraitName = (ns: string): Error =>
  new Error(`ramose/schema: duplicate trait name ${JSON.stringify(ns)}`);

export const entityTraitNameClash = (ns: string): Error =>
  new Error(
    `ramose/schema: ${JSON.stringify(ns)} is both an entity and a trait`,
  );

/** Direct traits, then every reachable trait once (post-order). Cycles throw. */
export const walkTraits = (
  traits: readonly ComposerLike[] | undefined,
): {
  readonly direct: readonly ComposerLike[];
  readonly all: readonly ComposerLike[];
} => {
  const direct = traits ?? [];
  const all: ComposerLike[] = [];
  const seen = new Set<ComposerLike>();
  const stack: ComposerLike[] = [];

  const visit = (trait: ComposerLike): void => {
    if (stack.includes(trait)) {
      throw traitCycle([...stack, trait].map((t) => t.ns));
    }
    if (seen.has(trait)) return;
    stack.push(trait);
    for (const inner of traitsOf(trait)) visit(inner);
    stack.pop();
    seen.add(trait);
    all.push(trait);
  };

  for (const trait of direct) visit(trait);
  return { direct, all };
};

/**
 * Flatten stamped fields onto a composer. Same field object (a diamond)
 * is idempotent; two different fields on one key throw.
 */
export const mergeComposerFields = <F>(
  ...maps: ReadonlyArray<Readonly<Record<string, F>>>
): Record<string, F> => {
  const out: Record<string, F> = {};
  for (const map of maps) {
    for (const [key, field] of Object.entries(map)) {
      const existing = out[key];
      if (existing !== undefined && existing !== field) {
        throw conflictingFieldName(
          key,
          fieldIdentOf(existing as { readonly ident?: unknown }, key),
          fieldIdentOf(field as { readonly ident?: unknown }, key),
        );
      }
      out[key] = field;
    }
  }
  return out;
};

export const flattenTraitFields = <F>(
  traits: readonly ComposerLike[] | undefined,
): Record<string, F> => {
  const { all } = walkTraits(traits);
  return mergeComposerFields(
    ...all.map((trait) => trait.fields as Readonly<Record<string, F>>),
  );
};

export const transitiveTraitIdents = (
  composer: ComposerLike,
): readonly string[] => {
  const { all } = walkTraits(traitsOf(composer));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const trait of all) {
    const ident = composerIdent(trait.ns);
    if (seen.has(ident)) continue;
    seen.add(ident);
    out.push(ident);
  }
  return out;
};

/** Reachable traits from a set of entities, keyed by ns. Duplicate ns clash. */
export const reachableTraits = (
  entities: Iterable<ComposerLike>,
): ReadonlyMap<string, ComposerLike> => {
  const byNs = new Map<string, ComposerLike>();
  for (const entity of entities) {
    const { all } = walkTraits(traitsOf(entity));
    for (const trait of all) {
      const seen = byNs.get(trait.ns);
      if (seen !== undefined && seen !== trait) {
        throw duplicateTraitName(trait.ns);
      }
      byNs.set(trait.ns, trait);
    }
  }
  return byNs;
};

/** A `Ref(Trait)` field's target, when the declared target is a trait. */
export const traitFromRefField = (field: unknown): ComposerLike | undefined => {
  if (typeof field !== "object" || field === null) return undefined;
  const resolve = (field as { schema?: { _resolve?: () => unknown } }).schema?._resolve;
  const target = resolve?.();
  if (typeof target !== "object" || target === null) return undefined;
  const tag = (target as { _tag?: unknown })._tag;
  const ns = (target as { ns?: unknown }).ns;
  if (tag !== "Trait" || typeof ns !== "string" || ns.length === 0) return undefined;
  return target as ComposerLike;
};

/**
 * Traits reachable by composition **or** declared as a `Ref(Trait)` target.
 * A catalog can name a trait only as a ref target; install still needs its
 * `:ramose/kind` metadata so writes can check membership.
 */
export const catalogTraits = (
  entities: Iterable<ComposerLike>,
): ReadonlyMap<string, ComposerLike> => {
  const listed = [...entities];
  const byNs = new Map(reachableTraits(listed));
  const referenced: ComposerLike[] = [];
  for (const entity of listed) {
    for (const field of Object.values(entity.fields)) {
      const trait = traitFromRefField(field);
      if (trait !== undefined) referenced.push(trait);
    }
  }
  if (referenced.length === 0) return byNs;
  for (const trait of walkTraits(referenced).all) {
    const seen = byNs.get(trait.ns);
    if (seen !== undefined && seen !== trait) throw duplicateTraitName(trait.ns);
    byNs.set(trait.ns, trait);
  }
  return byNs;
};

/** Same ident on two different field objects is a catalog conflict. */
export const assertUniqueIdents = (
  entities: Iterable<ComposerLike>,
): void => {
  const seen = new Map<string, unknown>();
  for (const entity of entities) {
    for (const [key, field] of Object.entries(entity.fields)) {
      const ident = fieldIdentOf(field, key);
      const prev = seen.get(ident);
      if (prev !== undefined && prev !== field) throw conflictingIdent(ident);
      seen.set(ident, field);
    }
  }
};

export const assertEntityTraitNames = (
  entityNss: Iterable<string>,
  traits: ReadonlyMap<string, ComposerLike>,
): void => {
  for (const ns of entityNss) {
    if (traits.has(ns)) throw entityTraitNameClash(ns);
  }
};
