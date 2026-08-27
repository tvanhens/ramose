/**
 * Alchemy local-mode integration suite.
 *
 * One stack deploy (see `fixtures.ts`), then every public contract against
 * the owned peer topology.
 */
import { setDefaultTimeout } from "bun:test";
import { registerAuthContract } from "../contracts/auth.contract.ts";
import { registerOperationsContract } from "../contracts/operations.contract.ts";
import { registerPeerContract } from "../contracts/peer.contract.ts";
import { registerExamples } from "./examples.ts";
import { localUrls } from "./fixtures.ts";
import { registerMultiClient } from "./multi-client.ts";
import { registerQuery } from "./query.ts";
import { registerCas } from "./cas.ts";
import { registerInstrumentation } from "./instrumentation.ts";
import { registerCatalogSeed, registerServiceBinding } from "./service-binding.ts";

setDefaultTimeout(90_000);

registerPeerContract({
  url: () => localUrls().openUrl,
  prefix: "local",
});
registerAuthContract({ urls: localUrls });
registerOperationsContract({ urls: localUrls });
registerMultiClient({ urls: localUrls });
registerExamples({ urls: localUrls });
registerServiceBinding({ urls: localUrls });
registerCatalogSeed({ urls: localUrls });
registerQuery({ urls: localUrls });
registerInstrumentation({ urls: localUrls });
registerCas({ urls: localUrls });
