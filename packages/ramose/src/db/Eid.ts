/**
 * An entity id, as data.
 *
 * `Eid<C>` is `{ readonly id: number }` and nothing else: no methods, no I/O,
 * no catalog object hanging off it. The catalog only exists in the type, as a
 * phantom, so two catalogs' eids do not silently mix and a row can be handed
 * straight to React as a key. Reading an entity is `db.pull(eid, shape)`.
 */

import type { AnyCatalog } from "./Catalog.ts";

export interface Eid<C extends AnyCatalog = AnyCatalog> {
  readonly id: number;
  /** Phantom: carries the catalog in the type, never present at runtime. */
  readonly _catalog?: C;
}

/** @internal Query rows and test fixtures wrap raw ids with this. */
export const makeEid = <C extends AnyCatalog>(id: number): Eid<C> => ({ id });
