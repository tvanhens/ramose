/**
 * `Ramose.ServerBinding` — the Worker service-binding transport.
 *
 * A Ramose server is reached over HTTP, and the cheapest, most private way for
 * one Worker to reach another on Cloudflare is a **service binding**:
 * `env.Ramose.fetch(...)` dispatches to the server Worker inside the same
 * colo, with no DNS, no TLS handshake, and no public hop. So the deploy-time
 * half lowers a `service` binding onto the host Worker (plus, when configured,
 * the bearer token as an env value), and the runtime half issues ordinary
 * requests through that Fetcher against the synthetic origin
 * `https://ramose.internal` — the server routes on the path, never the host.
 *
 * No database name is lowered: a server pins none. `ramose.db(name, catalog)`
 * picks it per call, which is what lets one binding serve a database per
 * tenant.
 *
 * Requires the server's `worker` to have been given as a `Cloudflare.Worker`
 * (a service binding needs a script name). With a bare URL, use
 * {@link import("./ServerHttp.ts").ServerHttp} instead.
 */

import type * as runtime from "@cloudflare/workers-types";
import * as Binding from "alchemy/Binding";
import { isWorker, WorkerEnvironment } from "alchemy/Cloudflare/Workers";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ReadDatabases } from "./ReadDatabases.ts";
import { ReadWriteDatabases } from "./ReadWriteDatabases.ts";
import type { ServerSource } from "./Source.ts";
import { databasesOf, readDatabasesOf } from "./Source.ts";
import type { Server } from "./Server.ts";
import { bindToken, envKeys } from "./ServerRuntime.ts";

/** The origin the server never looks at — service-binding dispatch ignores the host. */
export const SERVICE_ORIGIN = "https://ramose.internal";

/** @internal The shared deploy-time + runtime half of both capabilities. */
export const makeServerBinding = <Client>(options: {
  makeClient: (source: ServerSource) => Client;
}) =>
  Effect.gen(function* () {
    const env = yield* WorkerEnvironment;

    return Effect.fn(function* (server: Server) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        // Total: `undefined` when there is no host (a plan-time invoke, or a
        // client provided directly in a script). A host that is not a Worker
        // cannot take a service binding at all — say so loudly rather than
        // deploying something that fails on the first request.
        const host = yield* Binding.Host;
        if (isWorker(host)) {
          // A bare-URL server has no script name, so the `service` binding
          // below would be lowered with an empty target. Fail here rather
          // than at the Cloudflare API (or, worse, on the first request).
          if (typeof server.Props?.worker === "string") {
            return yield* Effect.die(
              new Error(
                `Ramose.ServerBinding needs a script name, and '${server.LogicalId}' was declared with a bare URL worker. Pass a Cloudflare.Worker as \`worker\`, or use Ramose.ServerHttp.`,
              ),
            );
          }
          yield* host.bind`${server}`({
            bindings: [
              {
                type: "service",
                name: envKeys(server).service,
                service: server.workerName,
              },
            ],
          });
        } else if (host !== undefined) {
          return yield* Effect.die(
            new Error(
              `Ramose.ServerBinding binds a Cloudflare Worker service binding, and the host is a '${host.Type}'. Use Ramose.ServerHttp instead.`,
            ),
          );
        }
      }
      return options.makeClient(yield* makeBindingSource(env, server));
    });
  });

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
        `ramose: no service binding "${keys.service}" on this Worker — the server's \`worker\` must be a Cloudflare.Worker, or use Ramose.ServerHttp`,
      );
    return {
      // Read per request, so the check sees the runtime env rather than the
      // empty one the deploy-time closure was built with. A binding that was
      // never lowered is a provisioning mistake, not a `DbError`: it dies.
      endpoint: Effect.suspend(() =>
        env[keys.service] === undefined
          ? Effect.die(missing())
          : Effect.map(token, (value) => ({
              url: SERVICE_ORIGIN,
              token: value,
            })),
      ),
      // Lazy — the WorkerEnvironment bindings are not populated until runtime.
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

/**
 * Both capabilities over a Worker service binding to the server. Provide it in
 * an app Worker's runtime layer; the Worker body is identical to what it would
 * be under {@link import("./ServerHttp.ts").ServerHttp}.
 *
 * Only the capability a Worker actually yields does any binding work, so
 * providing both costs nothing.
 */
export const ServerBinding: Layer.Layer<
  ReadWriteDatabases | ReadDatabases,
  never,
  WorkerEnvironment
> = Layer.mergeAll(
  Layer.effect(
    ReadWriteDatabases,
    Effect.suspend(() => makeServerBinding({ makeClient: databasesOf })),
  ),
  Layer.effect(
    ReadDatabases,
    Effect.suspend(() => makeServerBinding({ makeClient: readDatabasesOf })),
  ),
);
