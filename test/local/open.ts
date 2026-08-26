/**
 * The open (unauthenticated) peer used by the host App Worker.
 *
 * Lives in its own module so `App`'s declaration does not pull the rest
 * of the local topology (JWKS Worker, Stack) into a workerd bundle.
 * Server owns the Worker / DOs / R2 — do not hatch a second Worker here;
 * a hand-declared peer left the replica stuck during concurrent writes.
 */

import * as Ramose from "ramose";
import { operations } from "./ops.ts";

export const Open = Ramose.Server("Open", {
  peer: "OpenPeer",
  storage: "OpenStore",
  main: import.meta.resolve("./worker.ts"),
  operations,
});
