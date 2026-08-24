/**
 * Server-side db handles — the same wire as the browser client, without
 * `live` / `livePull`.
 *
 * A Worker (or Action) reaching the peer has no session socket to give, so
 * those methods always defect. They are not on this type.
 */

import type { Db, ReadDb } from "./db/Db.ts";
import type { EffectDb, EffectReadDb } from "./db/effect-types.ts";
import type { AnySchema } from "./db/Schema.ts";

type ServerEffectRead<C extends AnySchema> = Omit<
  EffectReadDb<C>,
  "live" | "livePull" | "asOf" | "history"
> & {
  asOf(t: number): ServerEffectRead<C>;
  readonly history: ServerEffectRead<C>;
};

type ServerEffectDb<C extends AnySchema> = Omit<
  EffectDb<C>,
  "live" | "livePull" | "asOf" | "history"
> & {
  asOf(t: number): ServerEffectRead<C>;
  readonly history: ServerEffectRead<C>;
};

/** `ReadDb` without streaming methods — the server-side read view. */
export type ServerReadDb<C extends AnySchema = AnySchema> = Omit<
  ReadDb<C>,
  "live" | "livePull" | "effect" | "asOf" | "history"
> & {
  asOf(t: number): ServerReadDb<C>;
  readonly history: ServerReadDb<C>;
  readonly effect: ServerEffectRead<C>;
};

/** `Db` without streaming methods — what `Ramose.Databases(Server)` hands back. */
export type ServerDb<C extends AnySchema = AnySchema> = Omit<
  Db<C>,
  "live" | "livePull" | "effect" | "asOf" | "history"
> & {
  asOf(t: number): ServerReadDb<C>;
  readonly history: ServerReadDb<C>;
  readonly effect: ServerEffectDb<C>;
};

export interface ServerDatabasesShape {
  db<C extends AnySchema>(name: string, schema: C): ServerDb<C>;
}

/** Type-level read-only view. Same credential, same wire; policy enforces. */
export interface ReadDatabasesShape {
  db<C extends AnySchema>(name: string, schema: C): ServerReadDb<C>;
}

const stripEffectRead = <C extends AnySchema>(effect: EffectReadDb<C>): ServerEffectRead<C> => {
  const { live: _l, livePull: _lp, asOf, history, ...rest } = effect;
  return {
    ...rest,
    asOf: (t: number) => stripEffectRead(asOf(t)),
    get history() {
      return stripEffectRead(history);
    },
  };
};

const stripRead = <C extends AnySchema>(db: ReadDb<C>): ServerReadDb<C> => {
  const { live: _l, livePull: _lp, effect, asOf, history, ...rest } = db;
  return {
    ...rest,
    asOf: (t: number) => stripRead(asOf(t)),
    get history() {
      return stripRead(history);
    },
    effect: stripEffectRead(effect),
  };
};

const stripEffectDb = <C extends AnySchema>(effect: EffectDb<C>): ServerEffectDb<C> => {
  const { live: _l, livePull: _lp, asOf, history, ...rest } = effect;
  return {
    ...rest,
    asOf: (t: number) => stripEffectRead(asOf(t)),
    get history() {
      return stripEffectRead(history);
    },
  };
};

/** Drop `live` / `livePull` from a full client handle. */
export const withoutLive = <C extends AnySchema>(db: Db<C>): ServerDb<C> => {
  const { live: _l, livePull: _lp, effect, asOf, history, ...rest } = db;
  return {
    ...rest,
    asOf: (t: number) => stripRead(asOf(t)),
    get history() {
      return stripRead(history);
    },
    effect: stripEffectDb(effect),
  };
};

/** Type-level read-only view of a server handle. Writes still exist at runtime. */
export const asRead = <C extends AnySchema>(db: ServerDb<C>): ServerReadDb<C> => db;
