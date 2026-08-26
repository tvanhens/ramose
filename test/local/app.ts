/**
 * Host Worker bound to the open Ramose peer.
 *
 * Async Worker (`main` points at `app-main.ts`) so the workerd bundle
 * is a plain `fetch` handler. An Effect Worker with `main: import.meta.url`
 * that imports `Ramose.Server` pulls deploy-time Alchemy into the isolate
 * and dies at startup (`TypeError: (intermediate value).resolve is not a
 * function`, alchemy 2.0.0-beta.72).
 *
 * `env.Open` is the owned peer Worker (`Server.Props.worker`) — a
 * service binding, the same hop `Ramose.Databases(Server)` registers.
 */

import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { Open } from "./open.ts";

type WorkerResource = { readonly Type?: string; readonly workerName?: string };

const openPeer = Effect.gen(function* () {
  yield* Open;
  const worker = (Open as { Props?: { worker?: WorkerResource } }).Props?.worker;
  if (worker === undefined) {
    return yield* Effect.die(new Error("Open peer Worker is not ready"));
  }
  return worker;
});

export const App = Cloudflare.Worker("App", {
  main: import.meta.resolve("./app-main.ts"),
  env: { Open: openPeer },
});

export default App;
