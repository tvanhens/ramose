import {
  QueryReplicaDO,
  createServer,
  createTransactorDO,
  deployOperationCatalogs,
} from "ramose/worker";
import * as Effect from "effect/Effect";
import { graphPathCatalogDeployment } from "./graph-path-catalog.ts";

const operationCatalogs = await Effect.runPromise(
  deployOperationCatalogs(graphPathCatalogDeployment),
);

export default createServer({ operationCatalogs });
export { QueryReplicaDO };
export const TransactorDO = createTransactorDO(operationCatalogs);
