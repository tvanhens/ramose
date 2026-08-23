import { createServer } from "ramose/worker";
import { operations } from "./src/todos.ts";

export default createServer({ operations });
export { QueryReplicaDO, TransactorDO } from "ramose/worker";
