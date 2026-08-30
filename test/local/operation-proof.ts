import type { OperationCatalogProof } from "ramose/worker";
import { catalogProof } from "./fixtures.ts";
import { OPERATION_DATABASES } from "./operation-catalog.ts";

export let operationProof: OperationCatalogProof;

export const loadOperationProof = async (base: string): Promise<void> => {
  operationProof = await catalogProof(base, OPERATION_DATABASES[0]!);
};
