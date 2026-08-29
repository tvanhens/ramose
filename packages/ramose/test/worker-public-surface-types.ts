/** Typechecked as an external consumer: no `src/internal` import is required. */

import * as Effect from "effect/Effect";
import { Catalog, Policy } from "ramose";
import { Schema } from "ramose/db";
import {
  createServer,
  createTransactorDO,
  deployOperationCatalogs,
  type DeployOperationCatalogsInput,
  type OperationCatalogDeploymentError,
  type OperationCatalogs,
} from "ramose/worker";

const Empty = Schema({});
const root = Catalog("consumer-operations", {
  schema: Empty,
  policy: Policy.compileReadAuthorization({ schema: Empty, rules: [] }),
});

type CallerArtifactHashIsNotPublic = "artifactHash" extends
  keyof DeployOperationCatalogsInput ? never : true;
export const callerArtifactHashIsNotPublic: CallerArtifactHashIsNotPublic = true;

export const consumerOperationCatalogs: Effect.Effect<
  OperationCatalogs,
  OperationCatalogDeploymentError
> = deployOperationCatalogs({
    root,
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
