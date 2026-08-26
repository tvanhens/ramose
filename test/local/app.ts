/**
 * Host Worker bound to the open Ramose peer.
 *
 * Declared from the stack after `yield* Open` so `env.Open` can be a
 * service binding to the owned peer Worker (by `workerName`). The
 * handler lives in `app-main.ts` — an async Worker bundle, not an
 * Effect entry — because an Effect Worker that imports `Ramose.Server`
 * pulls deploy-time Alchemy into workerd (alchemy 2.0.0-beta.72).
 */

import * as Cloudflare from "alchemy/Cloudflare";

export const makeApp = (openWorkerName: string) =>
  Cloudflare.Worker("App", {
    main: import.meta.resolve("./app-main.ts"),
    env: {
      Open: {
        Type: "Cloudflare.Worker",
        workerName: openWorkerName,
      },
    },
  });
