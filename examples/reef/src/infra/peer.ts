import * as Effect from "effect/Effect";
import {
  QueryReplicaDO,
  createServer,
  createTransactorDO,
  deployOperationCatalogs,
} from "ramose/worker";
import { deployment } from "../domain/schema.ts";

const operationCatalogs = await Effect.runPromise(
  deployOperationCatalogs(deployment),
);

export default createServer({ operationCatalogs, changesets: { canApprove: (caller) => caller.classes.includes("user") && !caller.classes.includes("agent"), requiresApproval: (caller) => caller.classes.includes("agent") } });
export { QueryReplicaDO };
export const TransactorDO = createTransactorDO(operationCatalogs);
