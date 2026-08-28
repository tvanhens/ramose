/**
 * `ramose` — the Alchemy 2 + Effect interface to Ramose.
 *
 * Everything on `ramose/db` (portable authoring and tagged errors), plus
 * the deploy-time `Server` and `Database` resources.
 *
 * Browser code imports `ramose/db` directly; the root entry is deploy-only.
 *
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import * as Cloudflare from "alchemy/Cloudflare";
 * import * as Ramose from "ramose";
 * import * as Layer from "effect/Layer";
 *
 * export const User = Ramose.Entity("user", {
 *   name: Ramose.Field.unique(Ramose.string(), "upsert"),
 * });
 * export const Movies = Ramose.Schema({ user: User });
 *
 * export const Server = Ramose.Server("Ramose", {
 *   databases: { movies: Movies },
 * });
 *
 * export default Alchemy.Stack("app", {
 *   providers: Layer.mergeAll(Cloudflare.providers(), Ramose.providers()),
 *   state: Cloudflare.state(),
 * }, Effect.gen(function* () {
 *   yield* Server;
 * }));
 * ```
 */

// ── the portable half, verbatim ────────────────────────────────────────────
export * from "./db/index.ts";

// ── the verifier/minter contract ─────────────────────────────────────────
export {
  type AuthConfig,
  type Claims,
  claims,
  type ClaimsInput,
  type ClaimsPolicy,
} from "./Auth.ts";

// ── resources ──────────────────────────────────────────────────────────────
export { Database } from "./Database.ts";
export {
  Catalog,
  type CatalogDefinition,
  type CatalogProps,
} from "./Catalog.ts";
export {
  DEFAULT_JWT_MAX_TTL,
  type AuthEnvValue,
  type ServerAuth,
  Server,
} from "./Server.ts";

// ── peer constants ─────────────────────────────────────────────────────────
export { PEER_COMPAT, PEER_BINDINGS, PEER_DO_CLASSES } from "./peer.ts";
export type { RamoseEnv } from "./RamoseEnv.ts";

export { providers, Providers } from "./Providers.ts";

// ── error → HTTP (app Workers; not on `ramose/db`) ─────────────────────────
export { type ErrorHttp, errorResponse, errorToHttp, statusOf, toDbError } from "./errorHttp.ts";
