import { createServer } from "ramose/worker";
import { operations } from "./ops.ts";

export default createServer({ operations });
export { QueryReplicaDO, TransactorDO } from "ramose/worker";
