import { createServer } from "ramose/worker";
import { operations } from "./e2e-ops.ts";

export default createServer({ operations });
export { QueryReplicaDO, TransactorDO } from "ramose/worker";
