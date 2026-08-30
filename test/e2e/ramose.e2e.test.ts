import { registerPeerContract } from "../contracts/peer.contract.ts";

registerPeerContract({
  url: () => process.env.RAMOSE_URL ?? "",
  token: () => process.env.RAMOSE_TOKEN,
  enabled: Boolean(process.env.RAMOSE_URL),
});
