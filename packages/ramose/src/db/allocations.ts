import type { RamoseVt } from "./valueTypes.ts";

/** One addressable position inside a decoded operation output. */
export type AllocationPathSegment = string | number;

/** One declared slot, normalized. */
export type AllocationSlot = {
  readonly slot: string;
  readonly path: readonly AllocationPathSegment[];
};

/** Canonically ordered declared slots. Empty when nothing is allocated. */
export type AllocationSlots = readonly AllocationSlot[];

type Decrement = [never, 0, 1, 2, 3, 4];

export type EntityRefPath<OCodec, Depth extends number = 5> = [Depth] extends
  [never] ? never
  : OCodec extends RamoseVt<"ref"> ? readonly []
  : OCodec extends { readonly value: infer Item }
    ? EntityRefPath<Item, Decrement[Depth]> extends
      infer Tail extends readonly AllocationPathSegment[]
      ? readonly [number, ...Tail]
    : never
  : OCodec extends { readonly fields: infer Fields } ? {
      [Key in keyof Fields & string]: EntityRefPath<
        Fields[Key],
        Decrement[Depth]
      > extends infer Tail extends readonly AllocationPathSegment[]
        ? readonly [Key, ...Tail]
        : never;
    }[keyof Fields & string]
  : never;

/**
 * Author-facing declaration: slot name to the output path it allocates.
 * Only entity-reference positions of the operation's own declared output
 * type-check, so a slot cannot be bound to a title or a count.
 */
export type AllocationDeclaration<OCodec> = {
  readonly [slot: string]: EntityRefPath<OCodec>;
};

const SLOT_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export const isAllocationSlotName = (value: unknown): value is string =>
  typeof value === "string" && SLOT_NAME.test(value);

const invalid = (detail: string): never => {
  throw new Error(`ramose/schema: allocation slot ${detail}`);
};

const normalizePath = (
  slot: string,
  path: unknown,
): readonly AllocationPathSegment[] => {
  if (!Array.isArray(path)) {
    invalid(`${slot} must declare an output path array`);
  }
  const segments = path as readonly unknown[];
  return Object.freeze(
    segments.map((segment): AllocationPathSegment => {
      if (typeof segment === "string") {
        if (segment.length === 0 || /[\u0000\s]/.test(segment)) {
          invalid(`${slot} has an empty or whitespace-bearing path segment`);
        }
        return segment;
      }
      if (
        typeof segment === "number" && Number.isSafeInteger(segment) &&
        segment >= 0
      ) {
        return segment;
      }
      return invalid(
        `${slot} path segments must be property names or array indexes`,
      );
    }),
  );
};

export const allocationPathKey = (
  path: readonly AllocationPathSegment[],
): string => JSON.stringify(path);

/**
 * Normalize and validate one declaration into the canonical ordered list a
 * queue record and an invocation digest may hold.
 *
 * Two slots may not name the same output position: the receipt maps a slot to
 * exactly one entity, so an aliased position would make the durable mapping
 * ambiguous in precisely the way this design exists to prevent.
 */
export const allocationSlots = (
  declaration: Readonly<Record<string, readonly AllocationPathSegment[]>> = {},
): AllocationSlots => {
  const slots: AllocationSlot[] = [];
  const paths = new Map<string, string>();
  for (const slot of Object.keys(declaration).sort()) {
    if (!SLOT_NAME.test(slot)) {
      invalid(`names must match ${SLOT_NAME.source}, not ${JSON.stringify(slot)}`);
    }
    const path = normalizePath(slot, declaration[slot]);
    const key = allocationPathKey(path);
    const owner = paths.get(key);
    if (owner !== undefined) {
      invalid(`${slot} and ${owner} both allocate the same output position`);
    }
    paths.set(key, slot);
    slots.push(Object.freeze({ slot, path }));
  }
  return Object.freeze(slots);
};

export const readAllocationPath = (
  output: unknown,
  path: readonly AllocationPathSegment[],
): unknown => {
  let cursor: unknown = output;
  for (const segment of path) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    if (typeof segment === "number") {
      if (!Array.isArray(cursor) || !Object.hasOwn(cursor, segment)) return undefined;
      cursor = cursor[segment];
    } else {
      if (Array.isArray(cursor) || !Object.hasOwn(cursor, segment)) return undefined;
      cursor = (cursor as Record<string, unknown>)[segment];
    }
  }
  return cursor;
};
