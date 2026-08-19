/**
 * One client for the page, closed with it.
 *
 * `Ramose.connect` throws only on a provisioning mistake (a malformed URL),
 * and the session socket is opened lazily by the first read, so module scope
 * is honest — no runtime to build, nothing to dispose but `ramose.close()`.
 * `ramose.db("todos", Todos)` is pure: naming a database costs no request,
 * and a browser never installs schema (`alchemy.run.ts` does that at deploy).
 */

import * as Ramose from "ramose/db";
import { Todos } from "../schema.ts";

const token = import.meta.env.VITE_RAMOSE_TOKEN;

const ramose = Ramose.connect({
  url: import.meta.env.VITE_RAMOSE_URL ?? "http://localhost:8787",
  // an open peer has no token: pass nothing rather than an empty credential
  token: token ? Ramose.token.static(token) : undefined,
});

export const db = ramose.db("todos", Todos);
