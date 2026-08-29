import * as Effect from "effect/Effect";
import { deployOperationCatalogs } from "ramose/worker";
import {
  QueryReplicaDO,
  createServer,
  createTransactorDO,
} from "../../packages/ramose/src/worker/testing.ts";
import { conformanceCatalogDeployment } from "./conformance-catalog.ts";

const operationCatalogs = await Effect.runPromise(
  deployOperationCatalogs(conformanceCatalogDeployment),
);

export default createServer({ operationCatalogs });
export { QueryReplicaDO };
export const TransactorDO = createTransactorDO(operationCatalogs);
