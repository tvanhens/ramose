/** Typechecked as an external consumer: no `src/internal` import is required. */

import * as Effect from "effect/Effect";
import { Catalog, Policy } from "ramose";
import { Schema } from "ramose/db";
import {
  createServer,
  createTransactorDO,
  deployOperationCatalogs,
  type OperationCatalogDeploymentError,
  type OperationCatalogs,
} from "ramose/worker";

const Empty = Schema({});
const root = Catalog("consumer-operations", {
  schema: Empty,
  policy: Policy.compileReadAuthorization({ schema: Empty, rules: [] }),
});

export const consumerOperationCatalogs: Effect.Effect<
  OperationCatalogs,
  OperationCatalogDeploymentError
> = deployOperationCatalogs({
    root,
    artifactHash: "9".repeat(64),
    deployments: [{ database: "consumer-db" }],
  });

export const consumerWorkerAssembly = Effect.map(
  consumerOperationCatalogs,
  (operationCatalogs) => ({
    server: createServer({ operationCatalogs }),
    TransactorDO: createTransactorDO(operationCatalogs),
    proof: operationCatalogs.proof("consumer-db"),
  }),
);
