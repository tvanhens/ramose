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
 * Every path through `Output` that lands on an entity-reference position — the
 * decoded type of a `Ramose.EntityId` output slot. Bounded depth keeps the
 * type finite for recursive schemas; a deeper allocation target is not
 * expressible, which is the intended pressure toward flat output contracts.
 */
export type EntityRefPath<Output, Depth extends number = 5> = [Depth] extends
  [never] ? never
  : [Output] extends [number] ? readonly []
  : Output extends readonly (infer Item)[]
    ? EntityRefPath<Item, Decrement[Depth]> extends
      infer Tail extends readonly AllocationPathSegment[]
      ? readonly [number, ...Tail]
    : never
  : Output extends object ? {
      [Key in keyof Output & string]: EntityRefPath<
        Output[Key],
        Decrement[Depth]
      > extends infer Tail extends readonly AllocationPathSegment[]
        ? readonly [Key, ...Tail]
        : never;
    }[keyof Output & string]
  : never;

/**
 * Author-facing declaration: slot name to the output path it allocates.
 * Only entity-reference positions of the operation's own declared output
 * type-check, so a slot cannot be bound to a title or a count.
 */
export type AllocationDeclaration<Output> = {
  readonly [slot: string]: EntityRefPath<Output>;
};

/** Conservative, stable, and safe as an object key and in a canonical digest. */
const SLOT_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

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

/** Canonical text of one path, for duplicate detection and for the digest. */
export const allocationPathKey = (
  path: readonly AllocationPathSegment[],
): string =>
  path.map((segment) =>
    typeof segment === "number" ? `#${segment}` : `.${segment}`
  ).join("");

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
      if (!Array.isArray(cursor)) return undefined;
      cursor = cursor[segment];
    } else {
      if (Array.isArray(cursor)) return undefined;
      cursor = (cursor as Record<string, unknown>)[segment];
    }
  }
  return cursor;
};
