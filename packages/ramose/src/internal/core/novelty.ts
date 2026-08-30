import {
  type Datom,
  type DatomComparator,
  type IndexId,
  type Prefix,
  ALL_INDEXES,
  COMPARATORS,
  comparePrefix,
  valueEquals,
} from "./datom.ts";
import { type Chunk, lowerBound, sortedUnion, upperBound } from "./tree.ts";

export class SortedNovelty {
  private base: Datom[] = [];
  private pending: Datom[] = [];
  readonly cmp: DatomComparator;

  constructor(readonly index: IndexId) {
    this.cmp = COMPARATORS[index];
  }

  get size(): number {
    return this.base.length + this.pending.length;
  }

  add(datoms: readonly Datom[]): void {
    for (const d of datoms) this.pending.push(d);
  }

  private flush(): Datom[] {
    if (this.pending.length > 0) {
      const p = this.pending;
      this.pending = [];
      p.sort(this.cmp);
      const dp: Datom[] = [];
      for (let i = 0; i < p.length; i++) {
        if (i === 0 || this.cmp(p[i - 1], p[i]) !== 0) dp.push(p[i]);
      }
      this.base = this.base.length === 0 ? dp : sortedUnion(this.cmp, this.base, dp);
    }
    return this.base;
  }

  all(): readonly Datom[] {
    return this.flush();
  }

  range(prefix: Prefix): Chunk | undefined {
    const ds = this.flush();
    if (ds.length === 0) return undefined;
    const s = lowerBound(this.index, ds, prefix);
    if (s >= ds.length) return undefined;
    const e = upperBound(this.index, ds, prefix);
    if (s >= e) return undefined;
    return { datoms: ds, start: s, end: e };
  }

  dropThrough(maxT: number): void {
    const ds = this.flush();
    this.base = ds.filter((d) => d.t > maxT);
  }

  clear(): void {
    this.base = [];
    this.pending = [];
  }
}

export class Novelty {
  readonly byIndex: Record<IndexId, SortedNovelty> = {
    0: new SortedNovelty(0),
    1: new SortedNovelty(1),
    2: new SortedNovelty(2),
    3: new SortedNovelty(3),
  };
  private _count = 0;
  private _maxT = 0;

  add(datoms: readonly Datom[], avet: (a: number) => boolean, vaet: (a: number) => boolean): void {
    if (datoms.length === 0) return;
    this.byIndex[0].add(datoms);
    this.byIndex[1].add(datoms);
    const av: Datom[] = [];
    const va: Datom[] = [];
    for (const d of datoms) {
      if (avet(d.a)) av.push(d);
      if (vaet(d.a)) va.push(d);
      if (d.t > this._maxT) this._maxT = d.t;
    }
    if (av.length) this.byIndex[2].add(av);
    if (va.length) this.byIndex[3].add(va);
    this._count += datoms.length;
  }

  get count(): number {
    return this.byIndex[0].size;
  }
  get maxT(): number {
    return this._maxT;
  }

  dropThrough(maxT: number): void {
    for (const i of ALL_INDEXES) this.byIndex[i].dropThrough(maxT);
    this._count = this.byIndex[0].size;
  }

  clear(): void {
    for (const i of ALL_INDEXES) this.byIndex[i].clear();
    this._count = 0;
  }
}

export async function* mergeChunks(
  cmp: DatomComparator,
  tree: AsyncIterable<Chunk>,
  nov: Chunk | undefined,
): AsyncGenerator<Chunk, void, undefined> {
  if (nov === undefined) {
    yield* tree;
    return;
  }
  const nds = nov.datoms;
  let j = nov.start;
  const jEnd = nov.end;
  for await (const c of tree) {
    const ds = c.datoms;
    if (j >= jEnd || cmp(ds[c.end - 1], nds[j]) < 0) {
      yield c;
      continue;
    }
    const out: Datom[] = [];
    let i = c.start;
    const last = ds[c.end - 1];
    while (i < c.end && j < jEnd) {
      const x = cmp(ds[i], nds[j]);
      if (x < 0) out.push(ds[i++]);
      else if (x > 0) out.push(nds[j++]);
      else {
        out.push(ds[i++]);
        j++;
      }
    }
    while (i < c.end) out.push(ds[i++]);
    while (j < jEnd && cmp(nds[j], last) <= 0) out.push(nds[j++]);
    yield { datoms: out, start: 0, end: out.length };
  }
  if (j < jEnd) yield { datoms: nds, start: j, end: jEnd };
}

export async function* currentView(
  chunks: AsyncIterable<Chunk>,
  asOf?: number,
): AsyncGenerator<Datom[], void, undefined> {
  let pending: Datom | undefined;
  let held: Datom[] | undefined;
  for await (const c of chunks) {
    const ds = c.datoms;
    const start = c.start, end = c.end;
    if (start >= end) continue;
    if (held !== undefined) {
      const last = held[held.length - 1], first = ds[start];
      if (last.e === first.e && last.a === first.a && valueEquals(last.vt, last.v, first.vt, first.v)) {
        if (held.length > 1) yield held.slice(0, held.length - 1);
        pending = last;
      } else {
        yield held;
        pending = undefined;
      }
      held = undefined;
    }
    if (pending !== undefined) {
      const first = ds[start];
      if (!(pending.e === first.e && pending.a === first.a && valueEquals(pending.vt, pending.v, first.vt, first.v))) {
        if (pending.op) yield [pending];
        pending = undefined;
      }
    }
    if (pending === undefined && isPlainChunk(ds, start, end, asOf)) {
      if (start === 0 && end === ds.length) {
        held = ds as Datom[];
      } else {
        if (end - 1 > start) yield ds.slice(start, end - 1);
        pending = ds[end - 1];
      }
      continue;
    }
    const out: Datom[] = [];
    for (let i = start; i < end; i++) {
      const d = ds[i];
      if (asOf !== undefined && d.t > asOf) continue;
      if (pending !== undefined && pending.e === d.e && pending.a === d.a && valueEquals(pending.vt, pending.v, d.vt, d.v)) {
        pending = d;
      } else {
        if (pending !== undefined && pending.op) out.push(pending);
        pending = d;
      }
    }
    if (out.length) yield out;
  }
  if (held !== undefined) yield held;
  else if (pending !== undefined && pending.op) yield [pending];
}

function isPlainChunk(ds: readonly Datom[], start: number, end: number, asOf: number | undefined): boolean {
  let prev = ds[start];
  if (!prev.op || (asOf !== undefined && prev.t > asOf)) return false;
  for (let i = start + 1; i < end; i++) {
    const d = ds[i];
    if (!d.op || (asOf !== undefined && d.t > asOf)) return false;
    if (prev.e === d.e && prev.a === d.a && valueEquals(prev.vt, prev.v, d.vt, d.v)) return false;
    prev = d;
  }
  return true;
}

export function collapseCurrent(ds: readonly Datom[], asOf?: number): Datom[] {
  if (ds.length === 0 || isPlainChunk(ds, 0, ds.length, asOf)) return ds as Datom[];
  const out: Datom[] = [];
  let pending: Datom | undefined;
  for (let i = 0; i < ds.length; i++) {
    const d = ds[i];
    if (asOf !== undefined && d.t > asOf) continue;
    if (pending !== undefined && pending.e === d.e && pending.a === d.a && valueEquals(pending.vt, pending.v, d.vt, d.v)) {
      pending = d;
    } else {
      if (pending !== undefined && pending.op) out.push(pending);
      pending = d;
    }
  }
  if (pending !== undefined && pending.op) out.push(pending);
  return out;
}

export async function* filterAsOf(
  chunks: AsyncIterable<Chunk>,
  asOf: number,
): AsyncGenerator<Datom[], void, undefined> {
  for await (const c of chunks) {
    const out: Datom[] = [];
    for (let i = c.start; i < c.end; i++) if (c.datoms[i].t <= asOf) out.push(c.datoms[i]);
    if (out.length) yield out;
  }
}

export async function* rawView(chunks: AsyncIterable<Chunk>): AsyncGenerator<Datom[], void, undefined> {
  for await (const c of chunks) {
    if (c.start === 0 && c.end === c.datoms.length) yield c.datoms as Datom[];
    else yield c.datoms.slice(c.start, c.end);
  }
}

export function matchesPrefix(index: IndexId, d: Datom, p: Prefix): boolean {
  return comparePrefix(index, d, p) === 0;
}
