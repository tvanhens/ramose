/**
 * `@ripple/alchemy` — the Alchemy 2 + Effect interface to Ripple.
 *
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import * as Cloudflare from "alchemy/Cloudflare";
 * import * as Ripple from "@ripple/alchemy";
 * import { SchemaFx } from "@ripple/alchemy";
 * import * as Schema from "effect/Schema";
 * import * as Layer from "effect/Layer";
 *
 * export const User = SchemaFx.Namespace("user", {
 *   name: SchemaFx.Attr(Schema.String, { unique: "identity" }),
 * });
 * export const Movies = SchemaFx.Catalog({ user: User });
 *
 * export const Peer = Cloudflare.Worker("Peer", { main: "./packages/worker/src/index.ts", env: { … } });
 * export const Sys = Ripple.System("Sys", { peer: Peer });
 *
 * export default Alchemy.Stack("app", {
 *   providers: Layer.mergeAll(Cloudflare.providers(), Ripple.providers()),
 *   state: Cloudflare.state(),
 * }, Effect.gen(function* () {
 *   const system = SchemaFx.fromReadWrite(yield* Ripple.ReadWriteSystem(Sys));
 *   const movies = yield* system.create("movies", Movies);
 *   yield* movies.transact(function* (tx) {
 *     const ada = yield* tx.entity();
 *     yield* ada.add(User.name, "Ada");
 *   });
 * }));
 * ```
 */

export * as Client from "./Client.ts";
export type {
  DatabaseEndpoint,
  DatabaseHealth,
  DatabaseSource,
  FetchLike,
  QueryMeta,
  QueryOptions,
  QueryResponse,
  ReadDatabaseClient,
  ReadSystemClient,
  ReadWriteDatabaseClient,
  ReadWriteSystemClient,
  SystemEndpoint,
  SystemSource,
  TxAck,
  WriteDatabaseClient,
  WriteSystemClient,
} from "./Client.ts";
export * from "./DatabaseTypes.ts";
export * from "./Providers.ts";
export * from "./ReadSystem.ts";
export * from "./ReadSystemBinding.ts";
export * from "./ReadSystemHttp.ts";
export * from "./ReadSystemLocal.ts";
export * from "./ReadWriteSystem.ts";
export * from "./ReadWriteSystemBinding.ts";
export * from "./ReadWriteSystemHttp.ts";
export * from "./ReadWriteSystemLocal.ts";
export * from "./System.ts";
// `SystemBinding.ts` / `SystemHttp.ts` / `SystemLocal.ts` / `SystemRuntime.ts`
// are capability-internal scaffolding and are deliberately NOT re-exported
// (mirrors `alchemy/Cloudflare/KV/index.ts`).
export * from "./WriteSystem.ts";
export * from "./WriteSystemBinding.ts";
export * from "./WriteSystemHttp.ts";
export * from "./WriteSystemLocal.ts";
export * as SchemaFx from "./schema/index.ts";
export * from "./Session.ts";
