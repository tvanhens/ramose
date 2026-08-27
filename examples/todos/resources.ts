import * as Ramose from "ramose";
import { operations } from "./src/todos.ts";

/**
 * The owned peer: Server declares the Worker, both Durable Object classes,
 * PEER_COMPAT, and the STORE / TRANSACTOR / REPLICA bindings. `main` is the
 * todos operations entry; omit it to use `ramose/worker`.
 */
export const Server = Ramose.Server("Ramose", {
  main: import.meta.resolve("./peer.ts"),
  operations,
});
