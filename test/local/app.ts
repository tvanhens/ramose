/**
 * Host Worker bound to the open Ramose peer.
 *
 * Lives in its own module so `main: import.meta.url` does not pull
 * `Alchemy.Stack` into the workerd bundle (alchemy 2.0.0-beta.72).
 */

import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as Ramose from "ramose";
import { createNamed, Movies, User } from "./ops.ts";
import { Open } from "./resources.ts";

const { Query } = Ramose;
const namesQuery = Query.from(User).select({ name: User.name });

export const App = Cloudflare.Worker(
  "App",
  { main: import.meta.url },
  Effect.gen(function* () {
    const ramose = yield* Ramose.Databases(Open);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const path = request.url.split("?")[0] ?? "/";
        if (path === "/health") {
          return yield* HttpServerResponse.json({ ok: true, via: "service-binding" });
        }
        if (!path.startsWith("/t/")) {
          return yield* HttpServerResponse.json({ error: "not found" }, { status: 404 });
        }
        const name = path.slice("/t/".length);
        const db = ramose.db(name, Movies);
        if (request.method === "PUT") {
          const report = yield* db.effect.install();
          return yield* HttpServerResponse.json({ name, t: report.t });
        }
        const report = yield* db.effect.run(createNamed, { name: "Ada" });
        const names = yield* report.dbAfter.effect.query(namesQuery);
        return yield* HttpServerResponse.json({
          name,
          t: report.t,
          names: names.map((row) => row.name),
        });
      }).pipe(
        Effect.catch((e) => {
          const { status, body, headers } = Ramose.errorToHttp(Ramose.toDbError(e));
          return HttpServerResponse.json(body, { status, headers });
        }),
      ),
    };
  }).pipe(Effect.provide(Ramose.layer)),
);

export default App;
