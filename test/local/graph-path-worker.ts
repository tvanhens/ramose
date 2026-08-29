import {
  QueryReplicaDO,
  createServer,
  createTransactorDO,
} from "../../packages/ramose/src/worker/testing.ts";
import * as Effect from "effect/Effect";
import { graphPathCatalogDeployment } from "./graph-path-catalog.ts";
import { deployOperationCatalogs } from "ramose/worker";

const operationCatalogs = await Effect.runPromise(
  deployOperationCatalogs(graphPathCatalogDeployment),
);

export default createServer({ operationCatalogs });
export { QueryReplicaDO };
export const TransactorDO = createTransactorDO(operationCatalogs);
