import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import type { Server } from "./Server.ts";

export const envKeys = (server: Pick<Server, "LogicalId">) => ({
  service: server.LogicalId,
  url: `${server.LogicalId}_URL`,
});

export const bindOutput = <A>(
  key: string,
  output: Output.Output<A>,
): Effect.Effect<Effect.Effect<A>> =>
  output.bind(key) as Effect.Effect<Effect.Effect<A>>;

export const required = (
  key: string,
  accessor: Effect.Effect<string>,
): Effect.Effect<string> =>
  accessor.pipe(
    Effect.flatMap((value) =>
      value === undefined || value === null || value === ""
        ? Effect.die(
            new Error(
              `ramose: no value bound under "${key}" — the capability must be provided on a host that takes bindings (a Cloudflare.Worker, or an Alchemy.Action; Ramose.layer falls back to HTTPS when no service binding is present)`,
            ),
          )
        : Effect.succeed(value),
    ),
  );
