/**
 * @internal The reader half of the seam `Db.ts` attaches under
 * `Symbol.for("ramose.db.seam")` — see `DbSeam` there; the shapes must stay
 * compatible, and `packages/ramose/test/db-seam.test.ts` pins the contract.
 * It exists because `db.asOf(t)` is pure and builds a new object per call:
 * keyed by identity, an inline view would re-subscribe — and, through the
 * effect's own `setState`, loop — every render. The `key` is the structural
 * dependency a hook actually means.
 */

import type {
  ConnectionStatus,
  Schema,
  ReadDb,
  QueryObject,
  Subscription,
} from "../db/index.ts";

const DB_SEAM = Symbol.for("ramose.db.seam");

interface DbSeam {
  /** Equal iff two views read the same coordinates over the same client. */
  readonly key: string;
  /** `asOf(t)`'s `t`; `undefined` on a live (or history) view. */
  readonly asOf: number | undefined;
  /** Subscribe to session wakes; `undefined` on an HTTPS-only client. */
  readonly onWake: (cb: () => void) => (() => void) | undefined;
  /** The highest basis the session has seen; `undefined` without a session. */
  readonly t: () => number | undefined;
  /** Session generation; `0` before a socket exists. */
  readonly generation: () => number;
  /** Session / transport status. HTTPS-only is `"offline"`. */
  readonly status: () => ConnectionStatus;
  /**
   * Standing query that emits the raw wire result. Optional on test
   * doubles; every real client attaches it.
   */
  readonly liveRaw?: (
    query: QueryObject<unknown, unknown>,
  ) => Subscription<unknown, unknown>;
}

export const seamOf = <C extends Schema.Any>(
  db: ReadDb<C>,
): DbSeam | undefined =>
  (db as unknown as Partial<Record<symbol, DbSeam>>)[DB_SEAM];

/**
 * The effect / memo dependency a hook keys on `db`: structural when the seam
 * is there (every db a real client builds), identity for anything else (a
 * hand-rolled test double).
 */
export const viewDep = <C extends Schema.Any>(db: ReadDb<C>): unknown =>
  seamOf(db)?.key ?? db;

const objectKeys = new WeakMap<object, string>();
let nextObjectKey = 1;

/**
 * The view half of a live subscription key (`DbSeam.key`). Test doubles
 * without a seam get a stable per-object token so the cache Map can key
 * them as a string.
 */
export const viewKeyOf = <C extends Schema.Any>(db: ReadDb<C>): string => {
  const key = seamOf(db)?.key;
  if (key !== undefined) return key;
  const obj = db as object;
  let id = objectKeys.get(obj);
  if (id === undefined) {
    id = `#${nextObjectKey++}`;
    objectKeys.set(obj, id);
  }
  return id;
};
