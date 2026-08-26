/**
 * Peer contract against a running Ramose deployment (local `alchemy dev`
 * or a deployed URL).
 *
 *   RAMOSE_URL=http://localhost:1337 bun test test/e2e
 *   RAMOSE_URL=https://ramose-<stage>.<acct>.workers.dev RAMOSE_TOKEN=... bun test test/e2e
 *
 * Skipped when RAMOSE_URL is not set.
 */
import { registerPeerContract } from "../contracts/peer.contract.ts";

registerPeerContract({
  url: () => process.env.RAMOSE_URL ?? "",
  token: () => process.env.RAMOSE_TOKEN,
  enabled: Boolean(process.env.RAMOSE_URL),
});
