/** Host-side copy of the configured-root proof used to form public requests. */

import * as Effect from "effect/Effect";
import { deployOperationCatalogs } from "../../packages/ramose/src/worker/operation-catalogs.ts";
import {
  CONFORMANCE_DATABASES,
  conformanceCatalogDeployment,
} from "./conformance-catalog.ts";

const catalogs = await Effect.runPromise(
  deployOperationCatalogs(conformanceCatalogDeployment),
);
const proof = catalogs.proof(CONFORMANCE_DATABASES[0]!);
if (proof === undefined) throw new Error("local conformance proof is missing");

export const conformanceProof = proof;
