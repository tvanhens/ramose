/**
 * Bind a {@link Server} and obtain the client: `Databases`, whose one method
 * `db(name, catalog)` is pure — no request, no ensure, no socket per call.
 *
 * The binding **is** the client. `ReadWriteDatabases` is a single identifier
 * that is simultaneously the binding's Context tag, its type, and the callable
 * — `yield* Ramose.ReadWriteDatabases(Server)`. Which wire it uses is the
 * transport layer's business (`Ramose.ServerBinding` or `Ramose.ServerHttp`);
 * the Worker body is identical under either.
 *
 * @binding
 * @product Ramose
 * @category Storage & Databases
 */

import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { DatabasesShape } from "./db/internal.ts";
import type { Server } from "./Server.ts";

export interface ReadWriteDatabases
  extends Binding.Service<
    ReadWriteDatabases,
    "Ramose.ReadWriteDatabases",
    (server: Server) => Effect.Effect<DatabasesShape>
  > {}

export const ReadWriteDatabases = Binding.Service<ReadWriteDatabases>(
  "Ramose.ReadWriteDatabases",
);
