/**
 * The least-privilege half of {@link import("./ReadWriteDatabases.ts").ReadWriteDatabases}:
 * `db(name, catalog)` hands back a `ReadDb<C>` — `q`, `live`, `pull`, `asOf`,
 * `history` — with no `transact` and no `install`.
 *
 * There is no write-only twin. A writer reads its own writes (`dbAfter`), so
 * "write but not read" is not a capability anyone can use; the two that exist
 * are "everything" and "reads only".
 *
 * @binding
 * @product Ramose
 * @category Storage & Databases
 */

import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { ReadDatabasesShape } from "./Source.ts";
import type { Server } from "./Server.ts";

export interface ReadDatabases
  extends Binding.Service<
    ReadDatabases,
    "Ramose.ReadDatabases",
    (server: Server) => Effect.Effect<ReadDatabasesShape>
  > {}

export const ReadDatabases = Binding.Service<ReadDatabases>(
  "Ramose.ReadDatabases",
);
