import * as Effect from "effect/Effect";
import { Schema } from "ramose/db";
import {
  createServer,
  createTransactorDO,
  deployOperationCatalogs,
  type DeployOperationCatalogsInput,
  type OperationCatalogDeploymentError,
  type OperationCatalogs,
} from "ramose/worker";

const Empty = Schema("consumer-operations", {});
Empty.applyPolicy(() => {});

type CallerArtifactHashIsNotPublic = "artifactHash" extends
  keyof DeployOperationCatalogsInput ? never : true;
export const callerArtifactHashIsNotPublic: CallerArtifactHashIsNotPublic = true;

export const consumerOperationCatalogs: Effect.Effect<
  OperationCatalogs,
  OperationCatalogDeploymentError
> = deployOperationCatalogs({
    root: Empty,
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
