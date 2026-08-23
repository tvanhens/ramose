/**
 * `ramose` — the Alchemy 2 + Effect interface to Ramose.
 *
 * Everything on `ramose/db` (schema, `connect`, `Db<C>`, the tagged
 * errors), plus the deploy-time half: the `Server` and `Database` resources,
 * the two capabilities and the two transport layers.
 *
 * Client bundlers that honor the `browser` export condition resolve this
 * specifier to `src/browser.ts` (the `ramose/db` surface) so they do not
 * pull Alchemy. App code should import `ramose/db` directly. Types stay
 * on this file so `import type { AuthConfig } from "ramose"` still works.
 *
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import * as Cloudflare from "alchemy/Cloudflare";
 * import * as Ramose from "ramose";
 * import * as Layer from "effect/Layer";
 *
 * export const User = Ramose.Entity("user", {
 *   name: Ramose.string({ unique: "upsert" }),
 * });
 * export const Movies = Ramose.Schema({ user: User });
 *
 * const RamoseWorker = Cloudflare.Worker("RamoseWorker", { main: import.meta.resolve("ramose/worker") });
 * export const Server = Ramose.Server("Ramose", { worker: RamoseWorker });
 * export const MoviesDb = Ramose.Database("movies", { server: Server, schema: Movies });
 *
 * export default Alchemy.Stack("app", {
 *   providers: Layer.mergeAll(Cloudflare.providers(), Ramose.providers()),
 *   state: Cloudflare.state(),
 * }, Effect.gen(function* () {
 *   yield* MoviesDb;
 * }));
 * ```
 */

// ── the portable half, verbatim ────────────────────────────────────────────
export * from "./db/index.ts";

// ── typed policy: deploy-time, so it is not on `/db` ────────────────────────
export { policy } from "./db/Policy.ts";
export * as Policy from "./db/Policy.ts";

// ── the verifier/minter contract ─────────────────────────────────────────
// `Claims` (the token payload) lives on `ramose/db`. `claims()` mints that
// same shape. Do not re-export a second Claims from here.
export { type AuthConfig, claims, type ClaimsInput } from "./Auth.ts";

// ── resources ──────────────────────────────────────────────────────────────
export { Database } from "./Database.ts";
export {
  AUTH_ENV_KEYS,
  authEnv,
  DEFAULT_JWT_MAX_TTL,
  internalSecret,
  type ServerAuth,
  Server,
} from "./Server.ts";

// ── capabilities and transports ────────────────────────────────────────────
export { ReadDatabases } from "./ReadDatabases.ts";
export { ReadWriteDatabases } from "./ReadWriteDatabases.ts";
export type { ReadDatabasesShape } from "./Source.ts";
export { ServerBinding } from "./ServerBinding.ts";
export { ServerHttp } from "./ServerHttp.ts";
export { providers, Providers } from "./Providers.ts";

// `ServerRuntime.ts` and `Source.ts` are internal scaffolding and are
// deliberately NOT re-exported (mirrors `alchemy/Cloudflare/KV/index.ts`):
// HTTP is Worker internals, not a second public API.
