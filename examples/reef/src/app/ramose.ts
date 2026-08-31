// docs:reef-client
import { createClient, type Client, type DatabaseMutations } from "ramose/client";
import { ROOT_DATABASE, Reef } from "../domain/schema.ts";
import { mintToken } from "./auth.ts";

export type ReefMutations = DatabaseMutations<typeof Reef>;
export type ReefClient = Client<ReefMutations>;

const peerOrigin = (): string =>
  (typeof process !== "undefined"
    ? process.env.BUN_PUBLIC_PEER_ORIGIN
    : undefined) || location.origin;

export const openReef = (userId: string): ReefClient =>
  createClient({
    url: peerOrigin(),
    root: ROOT_DATABASE,
    catalog: Reef,
    auth: async () => ({ token: await mintToken(), cacheKey: userId }),
  });
// enddocs:reef-client
