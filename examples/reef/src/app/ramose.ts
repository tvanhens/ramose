// docs:reef-client
import { createClient, type Client, type DatabaseMutations } from "ramose/client";
import { ROOT_DATABASE, Reef } from "../domain/schema.ts";
import { mintToken } from "./auth.ts";

export type ReefMutations = DatabaseMutations<typeof Reef>;
export type ReefClient = Client<ReefMutations>;

declare const REEF_PEER_ORIGIN: string | undefined;

const peerOrigin = (): string =>
  typeof REEF_PEER_ORIGIN === "string" && REEF_PEER_ORIGIN !== ""
    ? REEF_PEER_ORIGIN
    : location.origin;

export const openReef = (userId: string): ReefClient =>
  createClient({
    url: peerOrigin(),
    root: ROOT_DATABASE,
    catalog: Reef,
    auth: async () => ({ token: await mintToken(userId), cacheKey: userId }),
  });
// enddocs:reef-client
