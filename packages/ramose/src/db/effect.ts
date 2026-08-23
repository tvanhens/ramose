/**
 * `ramose/db/effect` — the Effect hatch for the portable client.
 *
 * App code uses promises on `ramose/db` (`db.q`, `db.run`, `db.live`).
 * Effect users reach the same client through:
 *
 * - `db.effect.*` — Effect / Stream variants of every db method, including
 *   `db.effect.transact` (the generator write, hatch-only).
 * - this module — `layer` / `Databases` for an Effect-native connect.
 *
 * `ramose/effect` remains the re-export of Effect's own modules (`Effect`,
 * `Schema`, `Stream`, …). Do not import those from here.
 */

export type { EffectDb, EffectReadDb } from "./effect-types.ts";
export {
  Databases,
  layer,
  type DatabasesShape,
  type EffectClientOptions,
  type EffectToken,
} from "./Databases.ts";
