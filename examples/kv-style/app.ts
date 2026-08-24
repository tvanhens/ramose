/**
 * An app Worker that uses the Ramose server declared in `resources.ts`.
 *
 * This lives in its own module for a reason: `main: import.meta.url` makes the
 * Worker its own bundle entrypoint, and alchemy's virtual entry does
 * `import entrypoint from <main>` — so whatever this module (transitively)
 * imports ends up inside the deployed Worker. Under alchemy 2.0.0-beta.72,
 * having `Alchemy.Stack(…, { providers: Cloudflare.providers() })` in that
 * graph bundles the engine and workerd fails at startup with
 * `TypeError: t.resolve is not a function`. Keeping the declaration here and
 * the stack next door avoids it; alchemy accepts a Worker declaration as a
 * module's default export (see alchemy/src/Runtime.ts).
 */

import * as Ramose from "ramose";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Server } from "./resources.ts";
import { Movies, User } from "./schema.ts";

const { Query } = Ramose;

/** Hoisted query values — stable, reusable across requests. */
const namesQuery = Query.from(User).select({ name: User.name });
const idsQuery = Query.from(User).select({ id: User.id });

// The Effect form: the outer generator runs at deploy time (it lowers a
// `service` binding to the server Worker, plus the shared token); the handler
// runs per request against `env.Ramose.fetch` — same colo, no public hop, no
// TLS handshake.

// docs:worker-app
export const App = Cloudflare.Worker(
  "App",
  { main: import.meta.url },
  Effect.gen(function* () {
    // The binding *is* the client. One `Databases`, bound once at init.
    const ramose = yield* Ramose.Databases(Server);
    // enddocs:worker-app

    // ── databases are names ──────────────────────────────────────────────────
    //
    // `ramose.db(name, Movies)` is pure: it validates nothing over the wire,
    // opens no socket and issues no request. Db-per-tenant is therefore a
    // function call — one per request, no resource, no deploy, no provisioning
    // per tenant. An illegal name fails the first operation with
    // `InvalidRequest`, so it never reaches the peer.
    //
    // The catalog is installed once, at deploy (`databases:` on Server) or
    // at tenant creation with `db.install()` — never per request. The token
    // is shared across every name: it is the peer's one `RAMOSE_TOKEN`,
    // checked for every tenant database and ignored when the peer has it
    // unset (https://ramose.ai/reference/server/).

    /** `PUT /t/:tenant` — the one place a tenant's catalog lands. One tx. */
    // docs:create-tenant
    const createTenant = (tenantId: string) =>
      Effect.gen(function* () {
        const report = yield* ramose.db(tenantId, Movies).effect.install();
        return yield* HttpServerResponse.json({ tenant: tenantId, t: report.t });
      });
    // enddocs:create-tenant

    /** Every other tenant request: pure `ramose.db`, zero network to open. */
    const tenantRoute = (tenantId: string) =>
      Effect.gen(function* () {
        const tenant = ramose.db(tenantId, Movies);

        // docs:tenant-transact
        const { t, dbAfter } = yield* tenant.effect.transact(function* (tx) {
          const ada = yield* tx.entity();
          yield* ada.set(User.name, "Ada");
        });
        // `dbAfter` carries the min-`t` floor, so this reads its own write
        const names = yield* dbAfter.effect.query(namesQuery);
        // enddocs:tenant-transact
        return yield* HttpServerResponse.json({
          tenant: tenantId,
          t,
          names: names.map((r) => r.name),
        });
      });

    return {
      fetch: Effect.gen(function* () {
        // `HttpServerRequest.fromWeb` strips the origin, so `url` is already
        // "/path?query". Valid database names are URL-safe by construction, so
        // the raw segment is used as-is: anything percent-encoded (say
        // `/t/bad%2Fname`) simply fails the name check → `InvalidRequest` → 400.
        const request = yield* HttpServerRequest.HttpServerRequest;
        const path = request.url.split("?")[0] ?? "/";
        if (path.startsWith("/t/")) {
          const tenantId = path.slice("/t/".length);
          return yield* request.method === "PUT"
            ? createTenant(tenantId)
            : tenantRoute(tenantId);
        }

        // The default database. `databases: { movies: Movies }` on Server
        // installed Movies on this name at deploy time.
        const db = ramose.db("movies", Movies);

        const report = yield* db.effect.transact(function* (tx) {
          const ada = yield* tx.entity();
          yield* ada.set(User.name, "Ada");
        });

        // Read your own write: `dbAfter` is the same db floored at `report.t`,
        // so a replica that has not caught up refetches its basis. No `sync`,
        // no second round trip, no public `minT`.
        const nameRows = yield* report.dbAfter.effect.query(namesQuery);
        const names = nameRows.map((r) => r.name);

        // …and the same query as of a past transaction. `asOf` is pure.
        // docs:as-of
        const beforeRows = yield* db.asOf(report.t - 1).effect.query(namesQuery);
        const before = beforeRows.map((r) => r.name);
        // enddocs:as-of

        // Entity ids come back from `select({ id: User.id })`; pulling one is
        // `db.pull` — a missing required field is `null`.
        const rows = yield* report.dbAfter.effect.query(idsQuery);
        const ada =
          rows.length === 0
            ? null
            : yield* report.dbAfter.effect.pull({ id: rows[0]!.id }, { name: User.name });

        return yield* HttpServerResponse.json({ t: report.t, names, before, ada });
      }).pipe(
        // docs:error-to-http
        // Tagged DbError → HTTP. One helper instead of a 9-arm catchTags.
        Effect.catch((e) => {
          const { status, body, headers } = Ramose.errorToHttp(Ramose.toDbError(e));
          return HttpServerResponse.json(body, { status, headers });
        }),
        // enddocs:error-to-http
      ),
    };
  // docs:worker-layer
  }).pipe(
    Effect.provide(Ramose.layer),
    // enddocs:worker-layer
  ),
);

export default App;
