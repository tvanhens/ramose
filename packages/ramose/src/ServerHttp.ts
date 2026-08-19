/**
 * `Ramose.ServerHttp` — the public-URL transport.
 *
 * No service binding, no Cloudflare-specific machinery: the client talks to
 * the server's public URL with the ambient `fetch`. That makes this the
 * portable transport — a Worker in another account, a Node/Bun server, a test
 * — the one that works when the server was given as a plain URL, and the one
 * an `Alchemy.Action` (or `alchemy dev`) uses, where the code runs in the
 * *engine's* process rather than in a deployed Worker. There is no third
 * "local" variant: unlike KV, Ramose has no second protocol to fall back to —
 * one HTTP API serves the Worker, the operator and the test.
 *
 * The server's URL and the token ride into the runtime as bound env values
 * (see `ServerRuntime.ts`), so under `alchemy dev` the URL is automatically
 * the local dev server's: `Output.bind` cooperates with the Action runtime
 * context (capture at init, resolve at apply). The binds happen when the
 * capability is bound (deploy time), not per request — see the note in
 * `ServerRuntime.ts`. Consequently this transport never calls `host.bind`.
 */

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { globalFetch } from "./db/internal.ts";
import { ReadDatabases } from "./ReadDatabases.ts";
import { ReadWriteDatabases } from "./ReadWriteDatabases.ts";
import type { Server } from "./Server.ts";
import { bindOutput, bindToken, envKeys, required } from "./ServerRuntime.ts";
import { databasesOf, readDatabasesOf, type ServerSource } from "./Source.ts";

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

/** @internal */
export const makeServerHttp = <Client>(options: {
  makeClient: (source: ServerSource) => Client;
}) =>
  Effect.gen(function* () {
    return Effect.fn(function* (server: Server) {
      return options.makeClient(yield* makeHttpSource(server));
    });
  });

/** Both capabilities over the server's public URL. */
export const ServerHttp: Layer.Layer<ReadWriteDatabases | ReadDatabases> =
  Layer.mergeAll(
    Layer.effect(
      ReadWriteDatabases,
      Effect.suspend(() => makeServerHttp({ makeClient: databasesOf })),
    ),
    Layer.effect(
      ReadDatabases,
      Effect.suspend(() => makeServerHttp({ makeClient: readDatabasesOf })),
    ),
  );
