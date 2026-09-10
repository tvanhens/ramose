// docs:reef-client
import { createClient, type Client, type DatabaseMutations } from "ramose/client";
import { ROOT_DATABASE, Reef } from "../domain/schema.ts";
import { createAuthProvider } from "ramose/better-auth/client";

export type ReefMutations = DatabaseMutations<typeof Reef>;
export type ReefClient = Client<ReefMutations>;

export const openReef = (userId: string) => {
  const credentials = createAuthProvider({ userId });
  const client: ReefClient = createClient({
    url: location.origin,
    database: ROOT_DATABASE,
    schema: Reef,
    auth: credentials,
  });
  return { client, credentials };
};
// enddocs:reef-client
