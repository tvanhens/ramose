import { BetterAuth } from "@alchemy.run/better-auth";
import { CloudflareD1 } from "@alchemy.run/better-auth/CloudflareD1";
import { ramoseToken } from "ramose/better-auth";
import * as Cloudflare from "alchemy/Cloudflare";
import { jwt } from "better-auth/plugins/jwt";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { pinned } from "./domain.ts";
import {
  AUTH_BASE_PATH,
  DEV_API_PORT,
  DEV_UI_ORIGIN,
  REEF_AUTH,
} from "../domain/shared.ts";

export const AuthDb = Cloudflare.D1.Database("AuthDb", pinned("authdb"));

const json = (body: unknown, status = 200) =>
  HttpServerResponse.json(body, { status });

export const Api = Cloudflare.Worker(
  "Api",
  {
    main: import.meta.url,
    workersDev: false,

    compatibility: { date: "2026-03-17", flags: ["nodejs_compat"] },
    dev: { port: DEV_API_PORT },

    ...pinned("api"),

  },
  Effect.gen(function* () {
    const auth = yield* BetterAuth({
      basePath: AUTH_BASE_PATH,
      emailAndPassword: { enabled: true },

      trustedOrigins: (request) => [
        DEV_UI_ORIGIN,
        ...(request ? [new URL(request.url).origin] : []),
      ],

      databaseHooks: {
        user: {
          create: {
            before: async (user) => ({ data: { ...user, emailVerified: true } }),
          },
        },
      },
      plugins: [
        // docs:jwt-plugin
        jwt({
          disableSettingJwtHeader: true,
          jwt: {
            issuer: REEF_AUTH.issuer,
            audience: REEF_AUTH.audience,
            expirationTime: `${REEF_AUTH.ttl}s`,
          },
        }),
        // enddocs:jwt-plugin

        // docs:mint-plugin
        ramoseToken({
          auth: REEF_AUTH,
          policy: { classes: ["user"] },
          classOf: ({ session }) => ({
            class: "user",
            attrs: {
              ...(session.user.name ? { name: session.user.name } : {}),
              ...(session.user.email ? { email: session.user.email } : {}),
            },
          }),
        }),
        // enddocs:mint-plugin
      ],
    });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const path = request.url.split("?")[0] ?? "/";
        if (path.startsWith(`${AUTH_BASE_PATH}/`)) {
          const incoming = yield* HttpServerRequest.toWeb(request).pipe(Effect.orDie);
          const origin = incoming.headers.get("x-reef-origin");
          const forwarded = origin === null ? incoming : new Request(
            new URL(new URL(incoming.url).pathname + new URL(incoming.url).search, origin),
            incoming,
          );
          return yield* auth.fetch.pipe(Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(forwarded),
          ));
        }
        if (path === "/api/health") {
          return yield* json({ ok: true });
        }
        return yield* json({ error: "not found" }, 404);
      }),
    };
  }).pipe(Effect.provide(CloudflareD1(AuthDb))),
);

export default Api;
