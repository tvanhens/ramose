import { createPeer } from "ramose/worker";
import { operations } from "./e2e-ops.ts";

export default createPeer({ operations });
export { QueryReplicaDO, TransactorDO } from "ramose/worker";
