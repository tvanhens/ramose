import { type Datom, ALL_INDEXES, COMPARATORS, type IndexId, Index } from "./datom.ts";
import { Db, type Roots } from "./db.ts";
import { Novelty, type NoveltyView } from "./novelty.ts";
import { DB_IDENT, FIRST_USER_EID, Schema, bootstrapDatoms, definesSchema } from "./schema.ts";
import { MemStore } from "./store.ts";
import { type BuildOptions, type NodeSource, type NodeStore, buildTree, mergeTree } from "./tree.ts";
import type { CompositionIndex } from "./composition.ts";
import { type ExpandedOp, type TxData, expandTx } from "./tx.ts";

export interface TxReport {
  dbBefore: Db;
  dbAfter: Db;
  t: number;
  txEid: number;
  txData: Datom[];
  txOps: ExpandedOp[];
  tempids: Record<string, number>;
}

export interface ValidatedTxReport<A> {
  readonly report: TxReport;
  readonly value: A;
}

export interface ConnectionOptions {
  store?: NodeStore;
  build?: BuildOptions;
  now?: () => number;
  composition?: CompositionIndex;
}

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

export async function deriveSchema(store: NodeSource, roots: Roots): Promise<Schema> {
  const schema = Schema.bootstrap();
  const tmp = new Db({ store, roots, novelty: new Novelty(), basisT: roots.t, schema, nextEid: 0 });
  const identDatoms = await tmp.datomsArray(Index.AEVT, { a: DB_IDENT });
  const all: Datom[] = [];
  for (const e of new Set(identDatoms.map((d) => d.e))) all.push(...(await tmp.datomsArray(Index.EAVT, { e })));
  return schema.apply(all);
}

export async function mergeRoots(
  store: NodeStore,
  roots: Roots,
  novelty: Novelty,
  maxT: number,
  build?: BuildOptions,
): Promise<Roots> {
  const pick = (i: IndexId) => novelty.byIndex[i].all().filter((d) => d.t <= maxT);
  const [eavt, aevt, avet, vaet] = await Promise.all([
    mergeTree(store, Index.EAVT, roots.eavt, pick(Index.EAVT), build),
    mergeTree(store, Index.AEVT, roots.aevt, pick(Index.AEVT), build),
    mergeTree(store, Index.AVET, roots.avet, pick(Index.AVET), build),
    mergeTree(store, Index.VAET, roots.vaet, pick(Index.VAET), build),
  ]);
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
  private composition: CompositionIndex | undefined;
  private txQueue: Promise<unknown> = Promise.resolve();
  readonly rootHistory: Roots[] = [];

  private constructor(opts: ConnectionOptions) {
    this.store = opts.store ?? new MemStore();
    this.build = opts.build;
    this.now = opts.now ?? (() => Date.now());
    this.composition = opts.composition;
  }

  static async create(opts: ConnectionOptions = {}): Promise<Connection> {
    const c = new Connection(opts);
    c.roots = await emptyRoots(c.store, c.build);
    c.rootHistory.push(c.roots);
    const boot = bootstrapDatoms();
    c.novelty.add(boot, (a) => c.schema.isAvet(a), (a) => c.schema.isVaet(a));
    c.basisT = 1;
    return c;
  }

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
      composition: this.composition,
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

  bindComposition(composition: CompositionIndex): void {
    if (this.composition !== undefined && this.composition !== composition) {
      throw new Error("connection already has deployed composition");
    }
    this.composition = composition;
  }

  applyDatoms(datoms: readonly Datom[]): void {
    if (datoms.length === 0) return;
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

  transactValidated<A>(
    txData: TxData,
    validate: (report: TxReport) => Promise<A> | A,
    txInstant?: number,
    beforeApply: () => void = () => undefined,
  ): Promise<ValidatedTxReport<A>> {
    const run = async (): Promise<ValidatedTxReport<A>> => {
      const dbBefore = this.db();
      const t = this.basisT + 1;
      const resolvedTxInstant = txInstant === undefined ? this.now() : txInstant;
      const res = await expandTx(
        dbBefore,
        txData,
        t,
        this.nextEid,
        resolvedTxInstant,
        this.composition === undefined ? undefined : { composition: this.composition },
      );
      const schemaAfter = this.schema.clone().apply(res.datoms);
      const isAvet = (a: number) => schemaAfter.isAvet(a);
      const isVaet = (a: number) => schemaAfter.isVaet(a);
      let noveltyAfter: NoveltyView;
      if (res.datoms.some((d) => definesSchema(d.a))) {
        const copied = new Novelty();
        copied.add(this.novelty.byIndex[Index.EAVT].all(), isAvet, isVaet);
        copied.add(res.datoms, isAvet, isVaet);
        noveltyAfter = copied;
      } else {
        noveltyAfter = this.novelty.overlay(res.datoms, isAvet, isVaet);
      }
      const dbAfter = new Db({
        store: this.store,
        roots: this.roots,
        novelty: noveltyAfter,
        basisT: t,
        schema: schemaAfter,
        nextEid: res.nextEid,
        composition: this.composition,
      });
      const report: TxReport = {
        dbBefore,
        dbAfter,
        t,
        txEid: res.txEid,
        txData: res.datoms,
        txOps: res.ops,
        tempids: res.tempids,
      };
      const value = await validate(report);
      beforeApply();
      this.nextEid = res.nextEid;
      this.schema = schemaAfter;
      this.novelty.add(res.datoms, (a) => this.schema.isAvet(a), (a) => this.schema.isVaet(a));
      this.basisT = t;
      return { report: { ...report, dbAfter: this.db() }, value };
    };
    const p = this.txQueue.then(run, run);
    this.txQueue = p.catch(() => undefined);
    return p;
  }

  transact(txData: TxData): Promise<TxReport> {
    return this.transactValidated(txData, () => undefined).then(({ report }) => report);
  }

  async index(upToT: number = this.basisT): Promise<Roots> {
    const maxT = Math.min(upToT, this.basisT);
    if (this.novelty.count === 0 || maxT <= this.roots.t) return this.roots;
    const roots = await mergeRoots(this.store, this.roots, this.novelty, maxT, this.build);
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

  dbAtRoot(roots: Roots): Db {
    return new Db({
      store: this.store,
      roots,
      novelty: new Novelty(),
      basisT: roots.t,
      schema: this.schema,
      nextEid: this.nextEid,
      composition: this.composition,
    });
  }
}
