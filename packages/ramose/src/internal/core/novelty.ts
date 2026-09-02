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

export interface SortedNoveltyView {
  readonly index: IndexId;
  readonly cmp: DatomComparator;
  readonly size: number;
  all(): readonly Datom[];
  range(prefix: Prefix): Chunk | undefined;
}

export interface NoveltyView {
  readonly byIndex: Record<IndexId, SortedNoveltyView>;
  readonly count: number;
  readonly maxT: number;
}

function rangeOf(index: IndexId, ds: readonly Datom[], prefix: Prefix): Chunk | undefined {
  if (ds.length === 0) return undefined;
  const s = lowerBound(index, ds, prefix);
  if (s >= ds.length) return undefined;
  const e = upperBound(index, ds, prefix);
  if (s >= e) return undefined;
  return { datoms: ds, start: s, end: e };
}

function unionChunks(cmp: DatomComparator, chunks: readonly Chunk[]): Chunk | undefined {
  if (chunks.length === 0) return undefined;
  if (chunks.length === 1) return chunks[0];
  let merged = sliceOf(chunks[0]);
  for (let i = 1; i < chunks.length; i++) merged = sortedUnion(cmp, merged, sliceOf(chunks[i]));
  return { datoms: merged, start: 0, end: merged.length };
}

function sliceOf(c: Chunk): readonly Datom[] {
  return c.start === 0 && c.end === c.datoms.length ? c.datoms : c.datoms.slice(c.start, c.end);
}

export class SortedNovelty implements SortedNoveltyView {
  private runs: Datom[][] = [];
  private pending: Datom[] = [];
  private stored = 0;
  readonly cmp: DatomComparator;

  constructor(readonly index: IndexId) {
    this.cmp = COMPARATORS[index];
  }

  get size(): number {
    return this.stored + this.pending.length;
  }

  add(datoms: readonly Datom[]): void {
    for (const d of datoms) this.pending.push(d);
  }

  private flush(): readonly Datom[][] {
    if (this.pending.length > 0) {
      const p = this.pending;
      this.pending = [];
      p.sort(this.cmp);
      const run: Datom[] = [];
      for (let i = 0; i < p.length; i++) {
        if (i === 0 || this.cmp(p[i - 1], p[i]) !== 0) run.push(p[i]);
      }
      this.runs.push(run);
      this.stored += run.length;
      while (this.runs.length >= 2 && this.runs[this.runs.length - 1].length >= this.runs[this.runs.length - 2].length) {
        const top = this.runs.pop()!;
        const below = this.runs.pop()!;
        const merged = sortedUnion(this.cmp, below, top);
        this.stored += merged.length - top.length - below.length;
        this.runs.push(merged);
      }
    }
    return this.runs;
  }

  private compact(): Datom[] {
    const runs = this.flush();
    if (runs.length === 0) return [];
    if (runs.length === 1) return runs[0];
    let merged = runs[0];
    for (let i = 1; i < runs.length; i++) merged = sortedUnion(this.cmp, merged, runs[i]);
    this.runs = [merged];
    this.stored = merged.length;
    return merged;
  }

  all(): readonly Datom[] {
    return this.compact();
  }

  range(prefix: Prefix): Chunk | undefined {
    const runs = this.flush();
    if (runs.length === 1) return rangeOf(this.index, runs[0], prefix);
    const hits: Chunk[] = [];
    for (const run of runs) {
      const c = rangeOf(this.index, run, prefix);
      if (c !== undefined) hits.push(c);
    }
    return unionChunks(this.cmp, hits);
  }

  dropThrough(maxT: number): void {
    const kept = this.compact().filter((d) => d.t > maxT);
    this.runs = kept.length === 0 ? [] : [kept];
    this.stored = kept.length;
  }

  clear(): void {
    this.runs = [];
    this.pending = [];
    this.stored = 0;
  }
}

export class LayeredSortedNovelty implements SortedNoveltyView {
  readonly index: IndexId;
  readonly cmp: DatomComparator;

  constructor(private readonly base: SortedNoveltyView, private readonly top: SortedNoveltyView) {
    this.index = base.index;
    this.cmp = base.cmp;
  }

  get size(): number {
    return this.base.size + this.top.size;
  }

  all(): readonly Datom[] {
    return sortedUnion(this.cmp, this.base.all(), this.top.all());
  }

  range(prefix: Prefix): Chunk | undefined {
    const hits: Chunk[] = [];
    const b = this.base.range(prefix);
    if (b !== undefined) hits.push(b);
    const t = this.top.range(prefix);
    if (t !== undefined) hits.push(t);
    return unionChunks(this.cmp, hits);
  }
}

export class Novelty implements NoveltyView {
  readonly byIndex: Record<IndexId, SortedNovelty> = {
    0: new SortedNovelty(0),
    1: new SortedNovelty(1),
    2: new SortedNovelty(2),
    3: new SortedNovelty(3),
  };
  private _count = 0;
  private _maxT = 0;

  overlay(datoms: readonly Datom[], avet: (a: number) => boolean, vaet: (a: number) => boolean): NoveltyView {
    const top = new Novelty();
    top.add(datoms, avet, vaet);
    return {
      byIndex: {
        0: new LayeredSortedNovelty(this.byIndex[0], top.byIndex[0]),
        1: new LayeredSortedNovelty(this.byIndex[1], top.byIndex[1]),
        2: new LayeredSortedNovelty(this.byIndex[2], top.byIndex[2]),
        3: new LayeredSortedNovelty(this.byIndex[3], top.byIndex[3]),
      },
      count: this.count + top.count,
      maxT: Math.max(this.maxT, top.maxT),
    };
  }

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
