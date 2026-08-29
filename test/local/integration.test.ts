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
import { registerBetterAuth } from "./better-auth.ts";
import { localUrls } from "./fixtures.ts";
import { registerBasisCache } from "./basis-cache.ts";
import { registerCas } from "./cas.ts";
import { registerInstrumentation } from "./instrumentation.ts";
import { registerNativeOperations } from "./native-operations.ts";
import { registerGraphPaths } from "./graph-paths.ts";
import { registerConformance } from "./conformance.ts";
import { registerReplication } from "./replication.ts";
import { registerStorage } from "./storage.ts";
import { registerTransactor } from "./transactor.ts";
import { registerSessions } from "./sessions.ts";

setDefaultTimeout(90_000);

registerPeerContract({
  url: () => localUrls().openUrl,
  prefix: "local",
});
registerAuthContract({ urls: localUrls });
registerOperationsContract({ urls: localUrls });
registerInstrumentation({ urls: localUrls });
registerNativeOperations({ urls: localUrls });
registerGraphPaths({ urls: localUrls });
registerConformance({ urls: localUrls });
registerReplication({ urls: localUrls });
registerBasisCache({ urls: localUrls });
registerSessions({ urls: localUrls });
registerCas({ urls: localUrls });
registerStorage({ urls: localUrls });
registerTransactor({ urls: localUrls });
registerBetterAuth({ urls: localUrls });
