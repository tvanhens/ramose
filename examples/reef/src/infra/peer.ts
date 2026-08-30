import { createServer } from "ramose/worker";
import { operations } from "../domain/operations.ts";

export default createServer({ operations });
export { QueryReplicaDO, TransactorDO } from "ramose/worker";
