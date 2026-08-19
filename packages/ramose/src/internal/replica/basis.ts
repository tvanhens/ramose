/**
 * Basis: what a peer needs to build a `Db` value without talking to the
 * Transactor — the current root record plus the novelty since that root.
 * Served by QueryReplica DOs (`GET /basis`), consumed by Workers.
 */

import {
  Db,
  type LogEntry,
  type NodeSource,
  type NoveltyFrameV1,
  Novelty,
  type RootRecord,
  type Roots,
  Schema,
  deriveSchema,
  entryFromFrame,
  txFrame,
} from "../core/index.ts";
import { recordToRoots } from "../storage/index.ts";

export interface Basis {
  v: 1;
  /** logical database name */
  db: string;
  /** basis t = last novelty t (or root.t) */
  t: number;
  root: RootRecord;
  /** transactions with t > root.t, ascending */
  novelty: NoveltyFrameV1[];
  /** replica id that served this basis */
  replica?: string;
}

export function makeBasis(db: string, root: RootRecord, entries: readonly LogEntry[], replica?: string): Basis {
  const t = entries.length ? entries[entries.length - 1].t : root.t;
  return { v: 1, db, t, root, novelty: entries.map(txFrame), replica };
}

/** Per-isolate cache of derived schemas keyed by root (EAVT hash). */
const schemaCache = new Map<string, Promise<Schema>>();

/** Build an immutable Db value from a basis over the given segment source. */
export async function dbFromBasis(store: NodeSource, basis: Basis, opts: { asOf?: number; history?: boolean } = {}): Promise<Db> {
  const roots: Roots = recordToRoots(basis.root);
  const key = roots.eavt.hash;
  let sp = schemaCache.get(key);
  if (!sp) {
    sp = deriveSchema(store, roots);
    schemaCache.set(key, sp);
    // never cache a failure (a transient read error would poison every db sharing this root hash)
    sp.catch(() => schemaCache.delete(key));
    if (schemaCache.size > 32) schemaCache.delete(schemaCache.keys().next().value as string);
  }
  const rootSchema = await sp;
  const entries = basis.novelty.map(entryFromFrame);
  const allDatoms = entries.flatMap((e) => e.datoms);
  const schema = allDatoms.length ? rootSchema.clone().apply(allDatoms) : rootSchema;
  const novelty = new Novelty();
  novelty.add(allDatoms, (a) => schema.isAvet(a), (a) => schema.isVaet(a));
  let db = new Db({ store, roots, novelty, basisT: basis.t, schema, nextEid: basis.root.next_eid });
  if (typeof opts.asOf === "number") db = db.asOf(opts.asOf);
  if (opts.history) db = db.history();
  return db;
}
