/**
 * `Ramose.Databases` — one capability, one transport.
 *
 * `yield* Ramose.Databases(Server)` is the client. The {@link layer}
 * auto-picks the wire: a Worker service binding when the host can take one,
 * otherwise the server's public URL. Read-only is a type-level view
 * (`ServerReadDb` / {@link asRead}), not a second tag.
 */

import * as Binding from "alchemy/Binding";
import { isWorker, WorkerEnvironment } from "alchemy/Cloudflare/Workers";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { resolveWorker, type Server, type ServerWorker } from "./Server.ts";
import { makeBindingSource, SERVICE_ORIGIN } from "./ServerBinding.ts";
import { makeHttpSource } from "./ServerHttp.ts";
import { envKeys } from "./ServerRuntime.ts";
import { serverDatabasesOf, type ServerDatabasesShape, type ServerSource } from "./Source.ts";

export type {
  ReadDatabasesShape,
  ServerDatabasesShape,
  ServerDb,
  ServerReadDb,
} from "./server-db.ts";
export { asRead } from "./server-db.ts";

export interface Databases
  extends Binding.Service<
    Databases,
    "Ramose.Databases",
    (server: Server) => Effect.Effect<ServerDatabasesShape>
  > {}

export const Databases = Binding.Service<Databases>("Ramose.Databases");

const optionalWorkerEnv = (): Effect.Effect<Record<string, any>> =>
  Effect.context<never>().pipe(
    Effect.map((ctx) => {
      const env = Context.getOption(
        ctx as Context.Context<WorkerEnvironment>,
        WorkerEnvironment,
      );
      return env._tag === "Some" ? env.value : {};
    }),
  );

const canBindService = (server: Server): boolean => {
  const worker = (server as { Props?: { worker?: unknown } }).Props?.worker;
  if (worker === undefined) return true;
  if (typeof worker === "string") return false;
  // A Cloudflare.Worker resource can take a service binding even when
  // `workerName` is still an Output. `{ url }` is not a Worker — resolving
  // it yields workerName "" and must not lower an empty target.
  if (typeof worker === "object" && worker !== null && (worker as { Type?: unknown }).Type === "Cloudflare.Worker") {
    return true;
  }
  return resolveWorker(worker as ServerWorker).workerName !== "";
};

/** @internal Shared deploy-time + runtime half. */
export const makeTransport = <Client>(options: {
  makeClient: (source: ServerSource) => Client;
}) =>
  Effect.gen(function* () {
    const env = yield* optionalWorkerEnv();

    return Effect.fn(function* (server: Server) {
      let preferBinding = env[envKeys(server).service] !== undefined;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isWorker(host) && canBindService(server)) {
          yield* host.bind`${server}`({
            bindings: [
              {
                type: "service",
                name: envKeys(server).service,
                service: server.workerName,
              },
            ],
          });
          preferBinding = true;
        }
      }
      if (preferBinding) {
        return options.makeClient(yield* makeBindingSource(env, server));
      }
      return options.makeClient(yield* makeHttpSource(server));
    });
  });

/**
 * One layer: service binding when the host Worker has it, otherwise HTTPS.
 * Provide it around a Worker or Action; nothing inside changes when the
 * wire swaps.
 */
export const layer: Layer.Layer<Databases> = Layer.effect(
  Databases,
  Effect.suspend(() => makeTransport({ makeClient: serverDatabasesOf })),
);

export { SERVICE_ORIGIN };
