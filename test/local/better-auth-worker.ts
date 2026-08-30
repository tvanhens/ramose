import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {
  authDatabase,
  localAuth,
  SECRET_A,
  workerProps,
} from "./better-auth-shared.ts";

const original = Effect.gen(function* () {
  const standard = yield* localAuth(
    "LocalStandardAuth",
    "/api/auth",
    SECRET_A,
    { migrate: true },
  );
  const denied = yield* localAuth(
    "LocalDeniedAuth",
    "/api/denied",
    SECRET_A,
    { classOf: () => null },
  );
  const undeclared = yield* localAuth(
    "LocalUndeclaredAuth",
    "/api/undeclared",
    SECRET_A,
    { classOf: () => "superuser" },
  );
  const attrs = yield* localAuth(
    "LocalAttrsAuth",
    "/api/attrs",
    SECRET_A,
    {
      classOf: ({ session }) => ({
        class: "authenticated",
        attrs: { email: session.user.email, locale: "en" },
      }),
    },
  );
  const custom = yield* localAuth(
    "LocalCustomAuth",
    "/api/custom",
    SECRET_A,
    { classOf: () => "authenticated", path: "/ramose-token" },
  );

  return {
    fetch: Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const pathname = new URL(request.url, "http://localhost").pathname;
      if (pathname.startsWith("/api/auth/")) return yield* standard.fetch;
      if (pathname.startsWith("/api/denied/")) return yield* denied.fetch;
      if (pathname.startsWith("/api/undeclared/")) {
        return yield* undeclared.fetch;
      }
      if (pathname.startsWith("/api/attrs/")) return yield* attrs.fetch;
      if (pathname.startsWith("/api/custom/")) return yield* custom.fetch;
      return HttpServerResponse.text("Not Found", { status: 404 });
    }),
  };
}).pipe(Effect.provide(authDatabase));

export default class LocalAuthWorker extends Cloudflare.Worker<LocalAuthWorker>()(
  "LocalBetterAuth",
  workerProps(import.meta.url),
  original,
) {}
