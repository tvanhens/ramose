import * as Ramose from "ramose";
import * as Cloudflare from "alchemy/Cloudflare";
import { Api } from "./api.ts";
import { pinned } from "./domain.ts";
import {
  DEV_PEER_PORT,
  DEV_UI_ORIGIN,
  REEF_AUTH,
} from "../domain/shared.ts";

const Store = Cloudflare.R2.Bucket("Store", pinned("store"));

export const Server = Ramose.Server("Ramose", {
  main: import.meta.resolve("./peer.ts"),
  storage: Store,
  dev: { port: DEV_PEER_PORT },
  ...pinned("peer"),
  env: {
    AUTH: Api,
  },
  auth: {
    jwt: REEF_AUTH,
    jwksService: "AUTH",
    jwksUrl: "https://auth.reef.internal/api/auth/jwks",
    allowedOrigins: DEV_UI_ORIGIN,
  },
});
