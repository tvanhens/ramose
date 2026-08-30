import type { Datom, Db, WireDatom } from "../internal/core/index.ts";
import type { Principal } from "./auth.ts";

export type SessionTxKind = "skip" | "tx" | "resync";

export type SessionTxDecision =
  | { readonly kind: "skip" }
  | { readonly kind: "resync" }
  | { readonly kind: "tx"; readonly datoms: WireDatom[] };

export interface SessionLogEntry {
  readonly t: number;
  readonly datoms: WireDatom[];
}

export interface SessionLog {
  readonly t: number;
  readonly rootT: number;
  readonly entries: readonly SessionLogEntry[];
}

export async function decideSessionTx(_opts: {
  datoms: readonly Datom[];
  principal?: Principal;
  ruleDbAfter: Db;
  ruleDbBefore: Db;
}): Promise<SessionTxDecision> {
  return { kind: "skip" };
}
