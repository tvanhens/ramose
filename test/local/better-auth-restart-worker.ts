import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import {
  authDatabase,
  localAuth,
  SECRET_A,
  workerProps,
} from "./better-auth-shared.ts";

const restart = Effect.gen(function* () {
  const instance = yield* localAuth(
    "LocalRestartAuth",
    "/api/auth",
    SECRET_A,
  );
  return { fetch: instance.fetch };
}).pipe(Effect.provide(authDatabase));

export default class LocalAuthRestartWorker extends Cloudflare.Worker<LocalAuthRestartWorker>()(
  "LocalBetterAuthRestart",
  workerProps(import.meta.url),
  restart,
) {}
