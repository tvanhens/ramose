import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import {
  authDatabase,
  localAuth,
  SECRET_B,
  workerProps,
} from "./better-auth-shared.ts";

const rotated = Effect.gen(function* () {
  const instance = yield* localAuth(
    "LocalRotatedAuth",
    "/api/auth",
    SECRET_B,
  );
  return { fetch: instance.fetch };
}).pipe(Effect.provide(authDatabase));

export default class LocalAuthRotatedWorker extends Cloudflare.Worker<LocalAuthRotatedWorker>()(
  "LocalBetterAuthRotated",
  workerProps(import.meta.url),
  rotated,
) {}
