/**
 * Reef peer Worker: the bundled operations registry is the write surface
 * for named mutations. Raw `/transact` stays open for admin / install.
 */
import { createServer } from "ramose/worker";
import { operations } from "../app/mutations.ts";

export default createServer({ operations });
export { QueryReplicaDO, TransactorDO } from "ramose/worker";
