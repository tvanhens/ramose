/**
 * In-memory `Connection`: the single-writer state machine over a `NodeStore`.
 *
 *   conn.transact(txData) → TxReport      (validates, assigns t, appends to novelty)
 *   conn.db()             → Db            (immutable snapshot)
 *   conn.index()          → Roots         (merge novelty into the trees; structural sharing)
 *
 * The Transactor DO reuses exactly this logic on top of its SQLite log and
 * the R2-backed store; the QueryReplica/peer use `Db` directly with roots +
 * novelty received over the wire.
 */

import { type Datom, ALL_INDEXES, COMPARATORS, type IndexId, Index } from "./datom.ts";
import { Db, type Roots } from "./db.ts";
import { Novelty } from "./novelty.ts";
import { DB_IDENT, FIRST_USER_EID, Schema, bootstrapDatoms } from "./schema.ts";
import { MemStore } from "./store.ts";
import { type BuildOptions, type NodeSource, type NodeStore, buildTree, mergeTree } from "./tree.ts";
import { type TxData, processTx } from "./tx.ts";

export interface TxReport {
  dbBefore: Db;
  dbAfter: Db;
  t: number;
  txEid: number;
  txData: Datom[];
  tempids: Record<string, number>;
}

export interface ConnectionOptions {
  store?: NodeStore;
  build?: BuildOptions;
  /** clock for :db/txInstant */
  now?: () => number;
}

/** Sort + dedup datoms for the given index. */
export function sortForIndex(index: IndexId, datoms: readonly Datom[]): Datom[] {
  const cmp = COMPARATORS[index];
  const arr = datoms.slice().sort(cmp);
  const out: Datom[] = [];
  for (let i = 0; i < arr.length; i++) if (i === 0 || cmp(arr[i - 1], arr[i]) !== 0) out.push(arr[i]);
  return out;
}

export async function emptyRoots(store: NodeStore, build?: BuildOptions): Promise<Roots> {
  const [eavt, aevt, avet, vaet] = await Promise.all(
    ALL_INDEXES.map((i) => buildTree(store, i, [], build)),
  );
  return { t: 0, eavt, aevt, avet, vaet };
}

/**
 * Build roots from a full datom set (bootstrap / bulk load). `schema` decides
 * AVET/VAET membership. `t` = max t in the set.
 */
export async function buildRoots(
  store: NodeStore,
  schema: Schema,
  datoms: readonly Datom[],
  build?: BuildOptions,
): Promise<Roots> {
  let t = 0;
  for (const d of datoms) if (d.t > t) t = d.t;
  const avetDs = datoms.filter((d) => schema.isAvet(d.a));
  const vaetDs = datoms.filter((d) => schema.isVaet(d.a));
  const eavt = await buildTree(store, Index.EAVT, sortForIndex(Index.EAVT, datoms), build);
  const aevt = await buildTree(store, Index.AEVT, sortForIndex(Index.AEVT, datoms), build);
  const avet = await buildTree(store, Index.AVET, sortForIndex(Index.AVET, avetDs), build);
  const vaet = await buildTree(store, Index.VAET, sortForIndex(Index.VAET, vaetDs), build);
  return { t, eavt, aevt, avet, vaet };
}

/**
 * Re-derive the schema from indexed datoms: every entity with a `:db/ident`
 * is loaded from EAVT (attribute entities are few, so this is cheap) and
 * projected through `Schema.apply`.
 */
export async function deriveSchema(store: NodeSource, roots: Roots): Promise<Schema> {
  const schema = Schema.bootstrap();
  const tmp = new Db({ store, roots, novelty: new Novelty(), basisT: roots.t, schema, nextEid: 0 });
  const identDatoms = await tmp.datomsArray(Index.AEVT, { a: DB_IDENT });
  const all: Datom[] = [];
  for (const e of new Set(identDatoms.map((d) => d.e))) all.push(...(await tmp.datomsArray(Index.EAVT, { e })));
  return schema.apply(all);
}

/** Merge novelty into existing roots (the indexer's core step). */
export async function mergeRoots(
  store: NodeStore,
  roots: Roots,
  novelty: Novelty,
  maxT: number,
  build?: BuildOptions,
): Promise<Roots> {
  const pick = (i: IndexId) => novelty.byIndex[i].all().filter((d) => d.t <= maxT);
  const eavt = await mergeTree(store, Index.EAVT, roots.eavt, pick(Index.EAVT), build);
  const aevt = await mergeTree(store, Index.AEVT, roots.aevt, pick(Index.AEVT), build);
  const avet = await mergeTree(store, Index.AVET, roots.avet, pick(Index.AVET), build);
  const vaet = await mergeTree(store, Index.VAET, roots.vaet, pick(Index.VAET), build);
  return { t: maxT, eavt, aevt, avet, vaet };
}

export class Connection {
  readonly store: NodeStore;
  private roots!: Roots;
  private novelty = new Novelty();
  private schema = Schema.bootstrap();
  private basisT = 0;
  private nextEid = FIRST_USER_EID;
  private readonly build: BuildOptions | undefined;
  private readonly now: () => number;
  private txQueue: Promise<unknown> = Promise.resolve();
  /** all roots ever published, by t (for as-of from an old root; GC keeps these) */
  readonly rootHistory: Roots[] = [];

  private constructor(opts: ConnectionOptions) {
    this.store = opts.store ?? new MemStore();
    this.build = opts.build;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Create an empty database (bootstrap schema installed at t = 1). */
  static async create(opts: ConnectionOptions = {}): Promise<Connection> {
    const c = new Connection(opts);
    c.roots = await emptyRoots(c.store, c.build);
    c.rootHistory.push(c.roots);
    const boot = bootstrapDatoms();
    c.novelty.add(boot, (a) => c.schema.isAvet(a), (a) => c.schema.isVaet(a));
    c.basisT = 1;
    return c;
  }

  /**
   * Restore a connection from persisted state (roots + un-indexed datoms).
   * `schemaDatoms` are not needed separately: the schema is re-derived by
   * scanning the attribute range of EAVT — cheap because attribute entities
   * are few and sort first.
   */
  static async restore(
    store: NodeStore,
    roots: Roots,
    logDatoms: readonly Datom[],
    nextEid: number,
    opts: ConnectionOptions = {},
  ): Promise<Connection> {
    const c = new Connection({ ...opts, store });
    c.roots = roots;
    c.rootHistory.push(roots);
    c.schema = await deriveSchema(store, roots);
    c.basisT = roots.t;
    c.nextEid = nextEid;
    if (logDatoms.length) c.applyDatoms(logDatoms);
    return c;
  }

  /** Bulk-load a database from a datom set (bench/bootstrap): builds trees directly. */
  static async fromDatoms(datoms: readonly Datom[], opts: ConnectionOptions = {}): Promise<Connection> {
    const c = new Connection(opts);
    const schema = Schema.bootstrap().apply(datoms);
    c.schema = schema;
    const all = bootstrapDatoms().concat(datoms);
    c.roots = await buildRoots(c.store, schema, all, c.build);
    c.rootHistory.push(c.roots);
    c.basisT = c.roots.t;
    let maxE = FIRST_USER_EID - 1;
    for (const d of datoms) if (d.e < 2 ** 42 && d.e > maxE) maxE = d.e;
    c.nextEid = maxE + 1;
    return c;
  }

  db(): Db {
    return new Db({
      store: this.store,
      roots: this.roots,
      novelty: this.novelty,
      basisT: this.basisT,
      schema: this.schema,
      nextEid: this.nextEid,
    });
  }

  get t(): number {
    return this.basisT;
  }
  get currentRoots(): Roots {
    return this.roots;
  }
  get noveltyCount(): number {
    return this.novelty.count;
  }
  get schemaView(): Schema {
    return this.schema;
  }
  get nextEntityId(): number {
    return this.nextEid;
  }

  /** Apply already-processed datoms (log replay / follower). */
  applyDatoms(datoms: readonly Datom[]): void {
    if (datoms.length === 0) return;
    // schema first so AVET/VAET membership of new attrs is right for later datoms in the same batch
    this.schema = this.schema.clone().apply(datoms);
    this.novelty.add(datoms, (a) => this.schema.isAvet(a), (a) => this.schema.isVaet(a));
    let maxT = this.basisT;
    let maxE = this.nextEid - 1;
    for (const d of datoms) {
      if (d.t > maxT) maxT = d.t;
      if (d.e < 2 ** 42 && d.e > maxE) maxE = d.e;
    }
    this.basisT = maxT;
    this.nextEid = maxE + 1;
  }

  /** Transact. Serialized: concurrent callers are queued (single writer). */
  transact(txData: TxData): Promise<TxReport> {
    const run = async (): Promise<TxReport> => {
      const dbBefore = this.db();
      const t = this.basisT + 1;
      const res = await processTx(dbBefore, txData, t, this.nextEid, this.now());
      this.nextEid = res.nextEid;
      this.schema = this.schema.clone().apply(res.datoms);
      this.novelty.add(res.datoms, (a) => this.schema.isAvet(a), (a) => this.schema.isVaet(a));
      this.basisT = t;
      return { dbBefore, dbAfter: this.db(), t, txEid: res.txEid, txData: res.datoms, tempids: res.tempids };
    };
    const p = this.txQueue.then(run, run);
    this.txQueue = p.catch(() => undefined);
    return p;
  }

  /**
   * Index: merge all novelty (t <= basisT) into new trees, publish new roots,
   * and drop merged novelty. Old Db values keep the old novelty object.
   */
  async index(upToT: number = this.basisT): Promise<Roots> {
    const maxT = Math.min(upToT, this.basisT);
    if (this.novelty.count === 0 || maxT <= this.roots.t) return this.roots;
    const roots = await mergeRoots(this.store, this.roots, this.novelty, maxT, this.build);
    // new novelty object (old snapshots keep the old one)
    const remaining = new Novelty();
    remaining.add(
      this.novelty.byIndex[Index.EAVT].all().filter((d) => d.t > maxT),
      (a) => this.schema.isAvet(a),
      (a) => this.schema.isVaet(a),
    );
    this.novelty = remaining;
    this.roots = roots;
    this.rootHistory.push(roots);
    return roots;
  }

  /** Db value as of an old root (uses only that root; novelty ignored). */
  dbAtRoot(roots: Roots): Db {
    return new Db({
      store: this.store,
      roots,
      novelty: new Novelty(),
      basisT: roots.t,
      schema: this.schema,
      nextEid: this.nextEid,
    });
  }
}
