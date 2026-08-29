/** Configured-root proof only; nested requests deliberately cannot supply it. */

import * as Effect from "effect/Effect";
import { deployOperationCatalogs } from "../../packages/ramose/src/worker/operation-catalogs.ts";
import {
  GRAPH_PATH_ROOT_DATABASE,
  graphPathCatalogDeployment,
} from "./graph-path-catalog.ts";

const catalogs = await Effect.runPromise(
  deployOperationCatalogs(graphPathCatalogDeployment),
);
const proof = catalogs.proof(GRAPH_PATH_ROOT_DATABASE);
if (proof === undefined) throw new Error("local graph-path root proof is missing");

export const graphPathRootProof = proof;
