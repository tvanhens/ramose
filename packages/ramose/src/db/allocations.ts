/**
 * Named client-ref allocation slots (#475 slice 1).
 *
 * An operation that creates entities an offline client must be able to
 * address *before* the server has committed them declares, in its inert
 * descriptor, a named slot for each such entity and binds it to a typed
 * entity-reference path in its own declared output:
 *
 * ```ts
 * Operation({
 *   input: Schema.Struct({ title: Schema.String }),
 *   output: Schema.Struct({ issue: Ramose.EntityId }),
 *   allocates: { issue: ["issue"] },
 *   run: …,
 * })
 * ```
 *
 * A durable queue record then persists `{ slot, clientRef }` pairs, and the
 * authoritative receipt returns `{ clientRef, entityId }` for exactly those
 * slots. Nothing is ever inferred from a transaction tempid name, a callback's
 * source, or the shape of a raw output value: a tempid is transaction-local
 * and an output number is not self-describing, so either inference would bind
 * a durable client identity to a coincidence.
 *
 * The declaration is inert data. It carries no executable body, and the list
 * is canonically ordered here so that the invocation digest (#487, consumed in
 * the next slice) covers a value that cannot depend on author key order.
 */

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

/**
 * Every path through an output *codec* that lands on an entity-reference slot.
 *
 * It walks the schema, not the decoded type. A decoded `Ramose.EntityId` and a
 * decoded `Schema.Number` are both `number`, so a decoded-type walk would let
 * `allocates: { issue: ["count"] }` type-check and bind a durable client ref to
 * an ordinary integer. The `RamoseVt<"ref">` brand only exists on the schema,
 * so matching it there is what makes the contract real.
 *
 * `Struct` exposes `fields` and `Array` exposes `value`; anything else — a
 * string, a literal, a union — has no entity-reference position and yields
 * `never`. Bounded depth keeps the type finite for recursive schemas, which is
 * the intended pressure toward flat output contracts.
 */
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

/** Conservative, stable, and safe as an object key and in a canonical digest. */
const SLOT_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/**
 * The one slot-name predicate. Declaration, durable construction, and durable
 * decoding all use it, so a name one of them accepts is never a name another
 * refuses — which would leave a committed row unreadable on the next restart.
 */
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

/**
 * Unambiguous text of one path, for duplicate detection.
 *
 * A delimiter-joined encoding cannot distinguish a property literally named
 * `"a.b"` from the nested pair `a` then `b`, so two genuinely different output
 * positions would collide and one valid declaration would be rejected as a
 * duplicate. JSON escapes the segments, and keeps a numeric index distinct
 * from the string that spells it.
 */
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

/**
 * Read the value one declared slot addresses out of a decoded output. Returns
 * `undefined` when the path does not exist, which the authoritative edge
 * treats as a failed allocation rather than as an absent mapping.
 */
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
      // Own properties only. An inherited value is not part of the output,
      // and reading one would resolve a slot against something the durable
      // record never carried.
      if (Array.isArray(cursor) || !Object.hasOwn(cursor, segment)) return undefined;
      cursor = (cursor as Record<string, unknown>)[segment];
    }
  }
  return cursor;
};
