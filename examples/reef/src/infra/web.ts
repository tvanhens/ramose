import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { serverBinding } from "ramose";
import { Api } from "./api.ts";
import { Server } from "./resources.ts";
import { REEF_DOMAIN, pinned } from "./domain.ts";

export const Web = Cloudflare.Worker("Web", {
  main: import.meta.resolve("./web-worker.ts"),
  ...pinned("web"),
  ...(REEF_DOMAIN ? { domain: REEF_DOMAIN } : {}),
  env: { AUTH: Api, DATA: Effect.map(Server, serverBinding), PUBLIC_URL: Cloudflare.Worker.URL },
  assets: {
    directory: "./examples/reef/dist",
    notFoundHandling: "single-page-application",
    runWorkerFirst: ["/api/*", "/db/*"],
  },
});
