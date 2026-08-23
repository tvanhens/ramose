/**
 * `Ramose.Database` — install this catalog on this name, at deploy.
 *
 * It is **not** a cloud object. A Ramose database is a *name*: the server
 * Worker routes `/db/:name/*` to `idFromName(name)` and the first transaction
 * materializes it, so there is nothing to create and nothing to delete. What
 * this resource owns is the one thing a name does need done once — the
 * catalog. `reconcile` runs `db.install()`, the same idempotent transaction
 * `ramose.db(name, catalog).install()` runs at tenant-creation time; `delete`
 * does nothing at all, because forgetting the resource must not erase a log.
 *
 * It replaces the `Alchemy.Action` + local-transport idiom: the provider talks
 * plain HTTPS to the server's resolved `url` with its `token`, which under
 * `alchemy dev` is the local dev server's URL for free.
 *
 * @resource
 * @product Ramose
 * @category Storage & Databases
 * @section Installing a catalog
 * @example The one place a catalog lands
 * ```typescript
 * const RamoseWorker = Cloudflare.Worker("RamoseWorker", { main: import.meta.resolve("ramose/worker") });
 * export const Server = Ramose.Server("Ramose", { worker: RamoseWorker });
 * export const TodosDb = Ramose.Database("todos", { server: Server, catalog: Todos });
 * ```
 *
 * One resource is not one tenant: db-per-tenant is `ramose.db(tenant, Todos)`
 * plus `db.install()` when the tenant is created. Declare a `Database` for the
 * names you know at deploy time.
 */

import type { InputProps } from "alchemy/Input";
import * as Provider from "alchemy/Provider";
import { isResourceOfType, Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type { Catalog } from "./db/index.ts";
import { InvalidRequest, NetworkError } from "./db/Errors.ts";
import { globalFetch, makeDatabases } from "./db/internal.ts";
import type { Providers } from "./Providers.ts";
import type { Server } from "./Server.ts";

/** @internal */
export const isDatabase = (value: unknown): value is Database =>
  isResourceOfType(value, "Ramose.Database");

/** @internal The public spelling is the argument of {@link Database}. */
export type DatabaseProps = {
  /** The server that serves this name. */
  server: Server;
  /** The catalog to install. `Ramose.Catalog({ … })`, shared with the app. */
  catalog: Catalog.Any;
  /** The database name. @default the resource's logical id */
  name?: string;
  /**
   * Cap on the install transaction, in ms. A catalog is a handful of datoms,
   * so this is not a budget — it is the line between "slow" and "never", which
   * `fetch` cannot draw on its own. @default 60000
   */
  timeoutMs?: number;
};

/** @internal The install's cap when {@link DatabaseProps.timeoutMs} is unset. */
export const DEFAULT_INSTALL_TIMEOUT_MS = 60_000;

export type Database = Resource<
  "Ramose.Database",
  DatabaseProps,
  {
    /** The name the catalog was installed on. */
    name: string;
    /** The server URL it was installed against. */
    server: string;
    /** The `t` of the install transaction — the catalog's basis. */
    t: number;
  },
  never,
  Providers
>;

const DatabaseResource = Resource<Database>("Ramose.Database");

/**
 * Declare a database name and install its catalog.
 *
 * `server` may be given as the `Ramose.Server(…)` *declaration* — a yieldable
 * Effect, not a resource instance — exactly as `Server` takes a
 * `Cloudflare.Worker` declaration: `yield*`ing it here is what makes the
 * engine order the install after the server and substitute the real URL at
 * reconcile.
 */
export const Database = Object.assign(
  (id: string, props: InputProps<DatabaseProps, "catalog">) =>
    DatabaseResource(
      id,
      Effect.gen(function* () {
        const server = props.server as
          | Server
          | Effect.Effect<Server, unknown, never>;
        return {
          ...props,
          server: Effect.isEffect(server) ? yield* server : server,
        };
      }) as unknown as Effect.Effect<InputProps<DatabaseProps>, never, never>,
    ),
  DatabaseResource,
) as typeof DatabaseResource;

/**
 * @internal `{ url, token }` off the server's attributes.
 *
 * At reconcile the engine has replaced the Outputs with their values, which
 * the `Server` type still spells as Outputs (the same cast `resolveWorker`
 * makes on the other side of the resource).
 */
const resolveServer = (
  server: Server,
): { url: string | undefined; token: Redacted.Redacted<string> | undefined } => {
  const resolved = server as unknown as {
    url?: string | undefined;
    token?: Redacted.Redacted<string> | string | undefined;
  };
  const token = resolved?.token;
  return {
    url: resolved?.url,
    token:
      token === undefined || token === ""
        ? undefined
        : typeof token === "string"
          ? Redacted.make(token)
          : token,
  };
};

/**
 * The install itself: one idempotent transaction over plain HTTPS.
 *
 * An illegal name never reaches the server — `ramose.db(name, catalog)` fails
 * the operation with `InvalidRequest` — and a server with no URL is the same
 * kind of mistake, so it fails the deploy rather than the first request.
 *
 * A server that has a URL and never answers on it is the third: `fetch` has no
 * deadline, so an unresolvable request parks the deploy indefinitely and the
 * run ends with a bare `fail` and nothing to read. `Ramose.Server` probes
 * `/health` for exactly this reason, but the probe cannot speak for `/db/:name`
 * — a bounded install is what makes the failure printable either way.
 */
const install = Effect.fn(function* (id: string, props: DatabaseProps) {
  const name = props.name ?? id;
  const { url, token } = resolveServer(props.server);
  if (url === undefined || url === "") {
    return yield* Effect.fail(
      new InvalidRequest({
        message: `ramose: the server for database ${JSON.stringify(name)} has no URL — deploy it before installing a catalog on it`,
      }),
    );
  }
  const timeoutMs = Math.max(1, props.timeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS);
  const { databases, close } = makeDatabases({
    url: Effect.succeed(url.replace(/\/+$/, "")),
    token: token === undefined ? undefined : Effect.succeed(token),
    fetch: globalFetch,
  });
  const report = yield* Effect.ensuring(
    databases.db(name, props.catalog).effect.install(),
    Effect.sync(close),
  ).pipe(
    Effect.timeoutOrElse({
      duration: `${timeoutMs} millis`,
      orElse: () =>
        Effect.fail(
          new NetworkError({
            message: `ramose: installing the catalog on ${JSON.stringify(name)} at ${url} did not finish within ${timeoutMs}ms — the server accepted the connection but never answered. Check that the Worker serving it is actually running (under \`alchemy dev\`, a Worker whose bundle failed still binds its port and answers nothing).`,
          }),
        ),
    }),
  );
  return { name, server: url, t: report.t };
});

/**
 * @internal Registered by `providers()`. One provider, both modes: an install
 * is the same HTTPS transaction against a deployed server and against the
 * `alchemy dev` one.
 */
export const DatabaseProvider = () =>
  Provider.succeed(Database, {
    reconcile: Effect.fn(function* ({ id, news }) {
      // Create and update are the same act: `install()` upserts the catalog.
      return yield* install(id, news);
    }),
    read: Effect.fn(function* ({ output }) {
      // Virtual: the persisted state row is the source of truth. There is no
      // "does this database exist" question to ask — a name always exists.
      return output ?? undefined;
    }),
    delete: Effect.fn(function* () {
      // A database is a name, and the log under it is append-only. Forgetting
      // the resource must not erase data: dropping it is a separate,
      // deliberate act (empty the bucket, delete the DO namespaces).
    }),
  });
