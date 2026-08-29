/** Host-side copy of the public startup assembly, used only to form test requests. */

import * as Effect from "effect/Effect";
import { deployOperationCatalogs } from "../../packages/ramose/src/worker/operation-catalogs.ts";
import {
  OPERATION_DATABASES,
  operationCatalogDeployment,
} from "./operation-catalog.ts";

const catalogs = await Effect.runPromise(
  deployOperationCatalogs(operationCatalogDeployment),
);
const proof = catalogs.proof(OPERATION_DATABASES[0]!);
if (proof === undefined) throw new Error("local operation catalog proof is missing");

export const operationProof = proof;
