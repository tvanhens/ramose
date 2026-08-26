/**
 * The Ramose provider collection. Merge it into the stack alongside the
 * cloud provider layers.
 *
 * @example
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import * as Cloudflare from "alchemy/Cloudflare";
 * import * as Ramose from "ramose";
 * import * as Layer from "effect/Layer";
 *
 * export default Alchemy.Stack("ramose", {
 *   providers: Layer.mergeAll(Cloudflare.providers(), Ramose.providers()),
 *   state: Cloudflare.state(),
 * }, Effect.gen(function* () { … }));
 * ```
 */

import * as Provider from "alchemy/Provider";
import * as Layer from "effect/Layer";
import { Database, DatabaseProvider } from "./Database.ts";
import { Server, ServerProvider } from "./Server.ts";

export class Providers extends Provider.ProviderCollection<Providers>()(
  "Ramose",
) {}

// Kept as a zero-argument factory rather than a bare Layer value: as a
// value the whole provider graph would be constructed at module load,
// on every import, instead of when a stack actually asks for it. It is
// also the shape alchemy uses in every provider package it ships.
// @effect-diagnostics-next-line lazyEffect:off
export const providers = () =>
  Layer.effect(Providers, Provider.collection([Server, Database])).pipe(
    Layer.provide(Layer.mergeAll(ServerProvider(), DatabaseProvider())),
    Layer.orDie,
  );
