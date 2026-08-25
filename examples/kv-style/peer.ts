import { createServer } from "ramose/worker";
import { operations } from "./operations.ts";

export default createServer({ operations });
export { QueryReplicaDO, TransactorDO } from "ramose/worker";
