/**
 * @internal Raw `/transact` hatch for tests and seed. Not on the public
 * `ramose/db` barrel — importing this from `Db.ts` would pull `Tx` (and
 * Effect) into the client `.d.ts`.
 */

import * as Effect from "effect/Effect";
import type { EffectDb } from "./effect-types.ts";
import type { AnySchema } from "./Schema.ts";
import { type Db, DB_SUBMIT, type TxReport } from "./Db.ts";
import { type DbError, InvalidRequest } from "./Errors.ts";
import { txBuilder, txOps, type Tx } from "./Tx.ts";

/**
 * Submit raw tx ops through the existing wire (`overlay.transact` or
 * `POST /transact`). Tests and seed paths only — not a public write.
 */
export const submitRaw = <C extends AnySchema>(
  db: Db<C> | EffectDb<C>,
  ops: readonly unknown[],
): Effect.Effect<TxReport<C>, DbError> => {
  const hatch = "effect" in db ? db.effect : db;
  const submit = (hatch as unknown as Record<symbol, unknown>)[DB_SUBMIT] as
    | ((tx: readonly unknown[]) => Effect.Effect<TxReport<C>, DbError>)
    | undefined;
  if (submit === undefined) {
    return Effect.fail(
      new InvalidRequest({ message: "ramose: raw submit is not available" }),
    );
  }
  return submit(ops);
};

/**
 * Run a builder body and {@link submitRaw} the collected ops.
 * Tests / seed only. App writes use {@link Db.run}.
 */
export const seedWrite = <C extends AnySchema>(
  db: Db<C> | EffectDb<C>,
  body: (tx: Tx<C>) => Generator<Effect.Effect<any, any, any>, unknown, any>,
): Effect.Effect<TxReport<C>, DbError> =>
  Effect.gen(function* () {
    const tx = txBuilder(("schema" in db ? db.schema : undefined) as C);
    const gen = body(tx);
    let step = gen.next();
    while (!step.done) {
      const value = yield* step.value;
      step = gen.next(value);
    }
    return yield* submitRaw(db, [...txOps(tx)]);
  }) as Effect.Effect<TxReport<C>, DbError>;
