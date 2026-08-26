/**
 * The open (unauthenticated) peer used by the host App Worker.
 *
 * Lives in its own module so `App`'s `main: import.meta.url` does not
 * pull `Cloudflare.Worker("Jwks")` — or the rest of the local topology —
 * into the workerd bundle. Under alchemy 2.0.0-beta.72 that graph dies
 * at startup with `TypeError: (intermediate value).resolve is not a function`.
 */

import * as Ramose from "ramose";
import { operations } from "./ops.ts";

export const Open = Ramose.Server("Open", {
  peer: "OpenPeer",
  storage: "OpenStore",
  main: import.meta.resolve("./worker.ts"),
  operations,
});
