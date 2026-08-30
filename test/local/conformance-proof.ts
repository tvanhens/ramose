import type { OperationCatalogProof } from "ramose/worker";
import { catalogProof } from "./fixtures.ts";
import { CONFORMANCE_DATABASES } from "./conformance-catalog.ts";

export let conformanceProof: OperationCatalogProof;

export const loadConformanceProof = async (base: string): Promise<void> => {
  conformanceProof = await catalogProof(base, CONFORMANCE_DATABASES[0]!);
};
