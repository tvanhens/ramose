import * as Provider from "alchemy/Provider";
import * as Layer from "effect/Layer";
import { Database, DatabaseProvider } from "./Database.ts";
import { Server, ServerProvider } from "./Server.ts";

export class Providers extends Provider.ProviderCollection<Providers>()(
  "Ramose",
) {}

// @effect-diagnostics-next-line lazyEffect:off
export const providers = () =>
  Layer.effect(Providers, Provider.collection([Server, Database])).pipe(
    Layer.provide(Layer.mergeAll(ServerProvider(), DatabaseProvider())),
    Layer.orDie,
  );
