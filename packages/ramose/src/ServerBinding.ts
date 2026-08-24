/**
 * @internal Service-binding source. The public surface is
 * {@link import("./Databases.ts").layer}, which auto-picks this hop when
 * the host is a Worker.
 */

import type * as runtime from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import type { Server } from "./Server.ts";
import { bindToken, envKeys } from "./ServerRuntime.ts";
import type { ServerSource } from "./Source.ts";

/** The origin the server never looks at — service-binding dispatch ignores the host. */
export const SERVICE_ORIGIN = "https://ramose.internal";

/** The service-binding {@link ServerSource}: `env[LogicalId].fetch`, token from env. */
export const makeBindingSource = (
  env: Record<string, any>,
  server: Server,
): Effect.Effect<ServerSource> =>
  Effect.gen(function* () {
    const keys = envKeys(server);
    const token = yield* bindToken(server);
    const missing = () =>
      new Error(
        `ramose: no service binding "${keys.service}" on this Worker — the server's worker must be a Cloudflare.Worker`,
      );
    return {
      endpoint: Effect.suspend(() =>
        env[keys.service] === undefined
          ? Effect.die(missing())
          : Effect.map(token, (value) => ({
              url: SERVICE_ORIGIN,
              token: value,
            })),
      ),
      fetch: (url, init) => {
        const peer = (env as Record<string, runtime.Fetcher | undefined>)[
          keys.service
        ];
        if (peer === undefined) return Promise.reject(missing());
        return peer.fetch(
          url as runtime.RequestInfo,
          init as runtime.RequestInit,
        ) as unknown as Promise<Response>;
      },
    };
  });
