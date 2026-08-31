import * as Ramose from "ramose";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import { Api } from "./api.ts";
import { REEF_DOMAIN, pinned, zoneOf } from "./domain.ts";
import {
  AUTH_BASE_PATH,
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
  ...(REEF_DOMAIN
    ? { routes: [{ pattern: `${REEF_DOMAIN}/db/*`, zoneName: zoneOf(REEF_DOMAIN) }] }
    : {}),
  env: {
    AUTH: Api,
  },
  auth: {
    jwt: REEF_AUTH,
    jwksService: "AUTH",
    jwksUrl: Effect.map(
      Api,
      (api) => Output.interpolate`${api.url}${AUTH_BASE_PATH}/jwks`,
    ),
    allowedOrigins: Effect.map(
      Api,
      (api) => Output.interpolate`${DEV_UI_ORIGIN},${api.url}`,
    ),
  },
});
