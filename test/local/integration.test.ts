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
import { localUrls } from "./fixtures.ts";
import { registerCas } from "./cas.ts";
import { registerInstrumentation } from "./instrumentation.ts";
import { registerStorage } from "./storage.ts";
import { registerSessions } from "./sessions.ts";

setDefaultTimeout(90_000);

registerPeerContract({
  url: () => localUrls().openUrl,
  prefix: "local",
});
registerAuthContract({ urls: localUrls });
registerOperationsContract({ urls: localUrls });
registerInstrumentation({ urls: localUrls });
registerSessions({ urls: localUrls });
registerCas({ urls: localUrls });
registerStorage({ urls: localUrls });
