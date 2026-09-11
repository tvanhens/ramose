import {
  QueryReplicaDO,
  createServer,
  createTransactorDO,
} from "../../packages/ramose/src/worker/testing.ts";
import * as Effect from "effect/Effect";
import { operationCatalogDeployment } from "./operation-catalog.ts";
import { deployOperationCatalogs } from "ramose/worker";

const operationCatalogs = await Effect.runPromise(
  deployOperationCatalogs(operationCatalogDeployment),
);

export default createServer({ operationCatalogs, changesets: { canApprove: (caller) => caller.claims.approveChangesets === true, requiresApproval: (caller) => caller.claims.requiresApproval === true } });
export { QueryReplicaDO };
export const TransactorDO = createTransactorDO(operationCatalogs);
