/**
 * An entity id, as data.
 *
 * `Eid<C>` over a catalog is `{ readonly id: number }` and nothing else: no
 * methods, no I/O, no catalog object hanging off it. The catalog only exists
 * in the type, as a phantom, so two catalogs' eids do not silently mix and a
 * row can be handed straight to React as a key. Reading an entity is
 * `db.pull(eid, shape)`.
 *
 * `Eid<N>` over a **namespace** is the row cell `select({ id: N.id })`
 * yields: the raw id *number* the peer answered, branded with the namespace
 * the field belongs to. The brand is a phantom too — the value stays a plain
 * number, so it still works as a React key, a `tx.set(id, …)` subject or a
 * predicate value — but the cells do not mix: a `User` id is not a `Todo`
 * id, and a bare `number` is not a cell. Hand it to the next query
 * (`N.id.is(cell)`) or to `db.pull` with no cast. `Query.from(N)` without
 * `.select` yields the full entity (`id` is `Eid<N>`). `.ids()` — and a
 * select-less pipe / generator that returns the focus var — still yields
 * the wrapped, catalog-branded `{ id }` form.
 */

import type { AnySchema } from "./Schema.ts";
import type { AnyEntity } from "./Entity.ts";

export type Eid<S extends AnySchema | AnyEntity = AnySchema> =
  [S] extends [AnyEntity]
    ? number & {
        /**
         * Phantom: the namespace this cell came from, never present at
         * runtime. Required in the type — an optional brand would let any
         * bare `number` pass for a cell.
         */
        readonly _ns: S;
      }
    : {
        readonly id: number;
        /** Phantom: carries the catalog in the type, never present at runtime. */
        readonly _catalog?: S;
      };

/**
 * The namespace-branded cells a catalog's rows can carry: `Eid<N>` for every
 * namespace in `C`. This is what lets a `select({ id: N.id })` cell be a
 * `db.pull` subject with no cast — and what keeps another catalog's cells out.
 */
export type SchemaEid<C extends AnySchema> = Eid<
  C["entities"][keyof C["entities"]]
>;

/** @internal Query rows and test fixtures wrap raw ids with this. */
export const makeEid = <C extends AnySchema>(id: number): Eid<C> =>
  ({ id }) as Eid<C>;
