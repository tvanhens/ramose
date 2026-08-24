/**
 * Reef peer Worker: the bundled operations registry is the write surface
 * for named mutations. The peer default (`writes: "operations"`) closes
 * raw `/transact` for app-class tokens; admin-class JWTs keep it for
 * `db.install()` / seed. Do not set `writes: "all"` here — Reef does not
 * need the old default.
 */
import { createServer } from "ramose/worker";
import { operations } from "../app/mutations.ts";

export default createServer({ operations });
export { QueryReplicaDO, TransactorDO } from "ramose/worker";
