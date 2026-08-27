/**
 * Session log walk. Application streaming is fail-closed until #347.
 *
 * The replica stays unfiltered internally. Nothing is emitted to a
 * client: silence does not leak `t` (LIVE-3, NI-1).
 */

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

/**
 * One committed entry, judged for an application consumer.
 * Until the authorized cursor lands, every entry is silence.
 */
export async function decideSessionTx(_opts: {
  datoms: readonly Datom[];
  principal?: Principal;
  ruleDbAfter: Db;
  ruleDbBefore: Db;
}): Promise<SessionTxDecision> {
  return { kind: "skip" };
}

/** Application snapshot dump — empty until #339/#343. */
export async function currentViewDatoms(_db: Db): Promise<WireDatom[]> {
  return [];
}
