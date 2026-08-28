import {
  QueryReplicaDO,
  createServer,
  createTransactorDO,
} from "ramose/worker";
import { operationCatalogs } from "./operation-catalog.ts";

export default createServer({ operationCatalogs });
export { QueryReplicaDO };
export const TransactorDO = createTransactorDO(operationCatalogs);
