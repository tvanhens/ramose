/**
 * Host Worker bound to the open Ramose peer.
 *
 * Async Worker (`main` points at `app-main.ts`) so the workerd bundle
 * is a plain `fetch` handler. An Effect Worker with `main: import.meta.url`
 * that imports `Ramose.Server` pulls deploy-time Alchemy into the isolate
 * and dies at startup (`TypeError: (intermediate value).resolve is not a
 * function`, alchemy 2.0.0-beta.72).
 *
 * `env.Open` is the owned peer Worker — a service binding, the same hop
 * `Ramose.Databases(Server)` registers as `env[LogicalId].fetch`.
 */

import * as Cloudflare from "alchemy/Cloudflare";
import { OpenPeer } from "./open.ts";

export const App = Cloudflare.Worker("App", {
  main: import.meta.resolve("./app-main.ts"),
  env: { Open: OpenPeer },
});

export default App;
