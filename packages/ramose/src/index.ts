/**
 * `ramose` — the Alchemy 2 + Effect interface to Ramose.
 *
 * Everything on `ramose/db` (schema, `connect`, `Db<C>`, the tagged
 * errors), plus the deploy-time half: the `Server` and `Database`
 * resources, one `Databases` capability, one auto-transport layer.
 *
 * Client bundlers that honor the `browser` export condition resolve this
 * specifier to `dist/browser.js` — `ramose/db` plus the alchemy-free
 * shared names (`policy` / `Policy` / `claims`) — so they do not pull
 * Alchemy. App code should import `ramose/db` directly. Types stay on
 * this file so `import type { AuthConfig } from "ramose"` still works.
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

// ── typed policy: deploy-time, so it is not on `/db` ────────────────────────
export { policy } from "./db/Policy.ts";
export * as Policy from "./db/Policy.ts";

// ── authorization authoring + IR compile (legacy Policy remains until #338)
export * as Authorization from "./authorization/index.ts";

// ── the verifier/minter contract ─────────────────────────────────────────
export { type AuthConfig, claims, type ClaimsInput, type ClaimsPolicy } from "./Auth.ts";

// ── resources ──────────────────────────────────────────────────────────────
export { Database } from "./Database.ts";
export {
  DEFAULT_JWT_MAX_TTL,
  type AuthEnvValue,
  type DatabaseSeed,
  type ServerAuth,
  Server,
} from "./Server.ts";

// ── peer constants ─────────────────────────────────────────────────────────
export { PEER_COMPAT, PEER_BINDINGS, PEER_DO_CLASSES } from "./peer.ts";
export type { RamoseEnv } from "./RamoseEnv.ts";

// ── one capability, one transport ──────────────────────────────────────────
export {
  asRead,
  Databases,
  layer,
  type ReadDatabasesShape,
  type ServerDatabasesShape,
  type ServerDb,
  type ServerReadDb,
} from "./Databases.ts";
export { providers, Providers } from "./Providers.ts";

// ── error → HTTP (app Workers; not on `ramose/db`) ─────────────────────────
export { type ErrorHttp, errorResponse, errorToHttp, statusOf, toDbError } from "./errorHttp.ts";
