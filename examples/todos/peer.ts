import { createPeer } from "ramose/worker";
import { operations } from "./src/todos.ts";

export default createPeer({ operations });
export { QueryReplicaDO, TransactorDO } from "ramose/worker";
