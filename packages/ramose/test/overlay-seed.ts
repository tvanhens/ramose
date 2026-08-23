/**
 * Build a local Connection snapshot for overlay tests. Session clients
 * apply `{ op: "resync" }` / `{ op: "tx" }` — they do not refetch `/query`.
 */

import { schemaTx } from "../src/db/ensure.ts";
import type { AnySchema } from "../src/db/Schema.ts";
import { Connection } from "../src/internal/core/conn.ts";
import { Index, type Datom } from "../src/internal/core/datom.ts";
import { toWireDatom, type WireDatom } from "../src/internal/core/log.ts";

export interface TxSnap {
  readonly t: number;
  readonly datoms: WireDatom[];
  readonly tempids: Record<string, number>;
}

export const snapshotOf = async (
  conn: Connection,
): Promise<{ t: number; datoms: WireDatom[] }> => {
  const datoms: WireDatom[] = [];
  for await (const chunk of conn.db().datoms(Index.EAVT, {})) {
    for (const d of chunk) datoms.push(toWireDatom(d));
  }
  return { t: conn.t, datoms };
};

export const txSnap = (rep: {
  readonly t: number;
  readonly txData: readonly Datom[];
  readonly tempids: Record<string, number>;
}): TxSnap => ({
  t: rep.t,
  datoms: rep.txData.map(toWireDatom),
  tempids: rep.tempids,
});

/** Empty follower with this catalog's schema — same idents the overlay installs. */
export const catalogWorld = async (schema: AnySchema): Promise<Connection> => {
  const conn = await Connection.create();
  await conn.transact(schemaTx(schema) as unknown[]);
  return conn;
};
