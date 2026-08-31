import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Output from "alchemy/Output";
import * as Ramose from "ramose";
import { AUDIENCE, ISSUER } from "./src/identity.ts";

export const DEV_PEER_PORT = 1341;
export const DEV_IDENTITY_PORT = 1342;

export const Identity = Cloudflare.Worker("Identity", {
  main: import.meta.resolve("./identity-worker.ts"),
  dev: { port: DEV_IDENTITY_PORT },
});

const Store = Cloudflare.R2.Bucket("Store", { name: "example-graph-store" });

export const Server = Ramose.Server("Ramose", {
  main: import.meta.resolve("./peer.ts"),
  storage: Store,
  dev: { port: DEV_PEER_PORT },
  env: { IDENTITY: Identity },
  auth: {
    jwksService: "IDENTITY",
    jwksUrl: Effect.map(Identity, (identity) => Output.interpolate`${identity.url}/jwks`),
    issuers: [ISSUER],
    aud: AUDIENCE,
    allowedOrigins: ["http://localhost:5173", "http://127.0.0.1:5173"],
  },
});
