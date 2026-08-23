/**
 * `ramose/db/effect` — the Effect hatch for the portable client.
 *
 * App code uses promises on `ramose/db` (`db.query`, `db.run`, `db.live`).
 * Effect users reach the same client through:
 *
 * - `db.effect.*` — Effect / Stream variants of every db method, including
 *   `db.effect.transact` (the generator write, hatch-only).
 * - this module — `layer` / `Databases` for an Effect-native connect.
 *
 * `ramose/effect` remains the re-export of Effect's own modules (`Effect`,
 * `Schema`, `Stream`, …). Do not import those from here.
 */

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";
import type { ClientOptions } from "./connect.ts";
import type { DbError } from "./Errors.ts";
import type { DatabasesShape } from "./client-shape.ts";
import {
  type DatabasesConfig,
  makeDatabases,
  resolvePlainToken,
  resolveTransport,
} from "./factory.ts";
import type { EffectOf, RedactedOf } from "./effect-types.ts";
import type { TokenInput } from "./token.ts";

export type { EffectDb, EffectReadDb } from "./effect-types.ts";
export type { DatabasesShape } from "./client-shape.ts";

/**
 * The capability. Yield it to get the client:
 *
 * ```typescript
 * const ramose = yield* Ramose.Databases;
 * const db = ramose.db("todos", Todos);
 * ```
 */
export class Databases extends Context.Service<Databases, DatabasesShape>()(
  "Ramose.Databases",
) {}

/**
 * Token the hatch / Worker transports still accept — a plain
 * {@link TokenInput} or an Effect of a redacted string.
 */
export type EffectToken =
  | TokenInput
  | Effect.Effect<Redacted.Redacted<string>, DbError>;

/** Options for {@link layer} — `ClientOptions` plus an Effect-valued token. */
export interface EffectClientOptions extends Omit<ClientOptions, "token"> {
  readonly token?: EffectToken;
}

/** Resolve a hatch token, including an Effect-valued one. */
const resolveEffectToken = (
  token: EffectToken | undefined,
): EffectOf<RedactedOf<string>, DbError> | undefined => {
  if (token === undefined) return undefined;
  if (Effect.isEffect(token)) return token;
  return resolvePlainToken(token);
};

const configure = (options: EffectClientOptions): DatabasesConfig => ({
  ...resolveTransport(options),
  token: resolveEffectToken(options.token),
});

/**
 * A `Databases` over a peer URL. Scoped: the sockets it opens are closed when
 * the layer's scope closes (a `ManagedRuntime` disposed with the page, a
 * `Layer.launch`, a test).
 */
export const layer = (options: EffectClientOptions): Layer.Layer<Databases> =>
  Layer.effect(
    Databases,
    Effect.gen(function* () {
      const { databases, close } = makeDatabases(configure(options));
      yield* Effect.addFinalizer(() => Effect.sync(close));
      return databases;
    }),
  );
