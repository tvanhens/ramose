import {
  QueryReplicaDO,
  createServer,
  createTransactorDO,
  deployOperationCatalogs,
} from "ramose/worker";
import * as Effect from "effect/Effect";
import { operationCatalogDeployment } from "./operation-catalog.ts";

const operationCatalogs = await Effect.runPromise(
  deployOperationCatalogs(operationCatalogDeployment),
);

export default createServer({ operationCatalogs });
export { QueryReplicaDO };
export const TransactorDO = createTransactorDO(operationCatalogs);
