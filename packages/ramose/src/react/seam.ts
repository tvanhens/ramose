/**
 * @internal The reader half of the seam `Db.ts` attaches under
 * `Symbol.for("ramose.db.seam")` — see `DbSeam` there; the shapes must stay
 * compatible, and `packages/ramose/test/db-seam.test.ts` pins the contract.
 * It exists because `db.asOf(t)` is pure and builds a new object per call:
 * keyed by identity, an inline view would re-subscribe — and, through the
 * effect's own `setState`, loop — every render. The `key` is the structural
 * dependency a hook actually means.
 */

import type { Schema, ReadDb } from "../db/index.ts";

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
