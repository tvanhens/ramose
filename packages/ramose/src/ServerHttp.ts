/**
 * @internal HTTPS source. The public surface is
 * {@link import("./Databases.ts").layer}, which uses this hop when no
 * service binding is present (Actions, `alchemy dev`, a bare URL).
 */

import * as Effect from "effect/Effect";
import { globalFetch } from "./db/internal.ts";
import type { Server } from "./Server.ts";
import { bindOutput, bindToken, envKeys, required } from "./ServerRuntime.ts";
import type { ServerSource } from "./Source.ts";

/** The HTTPS {@link ServerSource}: `server.url` + `server.token`, over global `fetch`. */
export const makeHttpSource = (server: Server): Effect.Effect<ServerSource> =>
  Effect.gen(function* () {
    const keys = envKeys(server);
    const url = yield* bindOutput(keys.url, server.url);
    const token = yield* bindToken(server);
    return {
      endpoint: Effect.gen(function* () {
        return {
          url: yield* required(keys.url, url),
          token: yield* token,
        };
      }),
      fetch: globalFetch,
    };
  });
