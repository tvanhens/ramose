import type { OperationCatalogProof } from "ramose/worker";
import { catalogProof } from "./fixtures.ts";
import { GRAPH_PATH_ROOT_DATABASE } from "./graph-path-catalog.ts";

export let graphPathRootProof: OperationCatalogProof;

export const loadGraphPathRootProof = async (base: string): Promise<void> => {
  graphPathRootProof = await catalogProof(base, GRAPH_PATH_ROOT_DATABASE);
};
