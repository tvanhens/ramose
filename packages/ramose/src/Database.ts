import type { InputProps } from "alchemy/Input";
import * as Provider from "alchemy/Provider";
import { isResourceOfType, Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type { Schema } from "./db/index.ts";
import { InvalidRequest } from "./db/Errors.ts";
import type { Providers } from "./Providers.ts";
import type { Server } from "./Server.ts";

export const isDatabase = (value: unknown): value is Database =>
  isResourceOfType(value, "Ramose.Database");

export type DatabaseProps = {
  server: Server;
  schema: Schema.Any;
  name?: string;
  timeoutMs?: number;
};

export const DEFAULT_INSTALL_TIMEOUT_MS = 60_000;

export type Database = Resource<
  "Ramose.Database",
  DatabaseProps,
  {
    name: string;
    server: string;
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
  (id: string, props: InputProps<DatabaseProps, "schema">) =>
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

const resolveServer = (
  server: Server,
): { url: string | undefined } => {
  const resolved = server as unknown as {
    url?: string | undefined;
  };
  return {
    url: resolved?.url,
  };
};

export const installCatalog = Effect.fn(function* (args: {
  readonly name: string;
  readonly url: string;
  readonly schema: Schema.Any;
  readonly timeoutMs?: number | undefined;
}) {
  const { name, url } = args;
  if (url === undefined || url === "") {
    return yield* new InvalidRequest({
      message: `ramose: the server for database ${JSON.stringify(name)} has no URL — deploy it before installing a schema on it`,
    });
  }
  return yield* new InvalidRequest({
    message: `ramose: catalog install on ${JSON.stringify(name)} is closed until authorized catalog publication is wired`,
  });
});

const install = Effect.fn(function* (id: string, props: DatabaseProps) {
  const name = props.name ?? id;
  const { url } = resolveServer(props.server);
  return yield* installCatalog({
    name,
    url: url ?? "",
    schema: props.schema,
    timeoutMs: props.timeoutMs,
  });
});

// @effect-diagnostics-next-line lazyEffect:off
export const DatabaseProvider = () =>
  Provider.succeed(Database, {
    reconcile: Effect.fn(function* ({ id, news }) {
      return yield* install(id, news);
    }),
    read: Effect.fn(function* ({ output }) {
      return output ?? undefined;
    }),
    delete: Effect.fn(function* () {
    }),
  });
