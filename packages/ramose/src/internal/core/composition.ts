/**
 * Immutable entity/trait composition used at transaction and lookup
 * boundaries. Idents are composer keywords (`:issue`, `:taggable`).
 *
 * Production callers derive this from a validated deployed catalog unit.
 * Database-resident `:ramose/kind` / `:ramose/composes` / `:ramose/trait`
 * are not a source.
 */

export type CompositionTables = {
  readonly entities: Iterable<string>;
  readonly traits: Iterable<string>;
  readonly entityTraits: Iterable<readonly [string, Iterable<string>]>;
  readonly traitTraits?: Iterable<readonly [string, Iterable<string>]>;
};

export type CompositionIndex = {
  readonly isEntityIdent: (ident: string) => boolean;
  readonly isTraitIdent: (ident: string) => boolean;
  readonly transitiveTraits: (ident: string) => readonly string[];
};

const asIdent = (nameOrIdent: string): string =>
  nameOrIdent.startsWith(":") ? nameOrIdent : `:${nameOrIdent}`;

const freezeIdents = (values: Iterable<string>): ReadonlySet<string> => {
  const out = new Set<string>();
  for (const value of values) {
    if (value.length === 0) continue;
    out.add(asIdent(value));
  }
  return out;
};

const freezeTraitMap = (
  rows: Iterable<readonly [string, Iterable<string>]> | undefined,
): ReadonlyMap<string, readonly string[]> => {
  const out = new Map<string, readonly string[]>();
  if (rows === undefined) return out;
  for (const [composer, traits] of rows) {
    const ident = asIdent(composer);
    const seen = new Set<string>();
    const list: string[] = [];
    for (const trait of traits) {
      const next = asIdent(trait);
      if (seen.has(next)) continue;
      seen.add(next);
      list.push(next);
    }
    list.sort();
    out.set(ident, Object.freeze(list));
  }
  return out;
};

/** Build a frozen type-to-trait lookup. Composer and trait names may omit `:`. */
export const makeCompositionIndex = (tables: CompositionTables): CompositionIndex => {
  const entities = freezeIdents(tables.entities);
  const traits = freezeIdents(tables.traits);
  const entityTraits = freezeTraitMap(tables.entityTraits);
  const traitTraits = freezeTraitMap(tables.traitTraits);

  const transitiveTraits = (ident: string): readonly string[] => {
    const key = asIdent(ident);
    return entityTraits.get(key) ?? traitTraits.get(key) ?? [];
  };

  return Object.freeze({
    isEntityIdent: (ident: string): boolean => entities.has(asIdent(ident)),
    isTraitIdent: (ident: string): boolean => traits.has(asIdent(ident)),
    transitiveTraits,
  });
};
