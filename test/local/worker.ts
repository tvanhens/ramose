import { createServer } from "ramose/worker";
import { operations } from "./ops.ts";
import { operationCatalogs } from "./operation-catalog.ts";

const server = createServer({ operations, catalogs: operationCatalogs });

export default server;
export const TransactorDO = server.TransactorDO;
export const QueryReplicaDO = server.QueryReplicaDO;
