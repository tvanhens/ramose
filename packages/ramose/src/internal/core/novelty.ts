/**
 * Novelty: datoms newer than the current index root, kept sorted in memory
 * per index, plus the merge iterator that unions a tree scan with novelty
 * and the "current view" collapse that turns the full assert/retract history
 * into present-tense facts.
 */

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

/** One index's worth of sorted novelty. Adds are buffered; reads flush. */
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
      // dedup within p
      const dp: Datom[] = [];
      for (let i = 0; i < p.length; i++) {
        if (i === 0 || this.cmp(p[i - 1], p[i]) !== 0) dp.push(p[i]);
      }
      this.base = this.base.length === 0 ? dp : sortedUnion(this.cmp, this.base, dp);
    }
    return this.base;
  }

  /** All datoms, sorted (do not mutate). */
  all(): readonly Datom[] {
    return this.flush();
  }

  /** Slice of datoms matching the prefix: [start, end) into `all()`. */
  range(prefix: Prefix): Chunk | undefined {
    const ds = this.flush();
    if (ds.length === 0) return undefined;
    const s = lowerBound(this.index, ds, prefix);
    if (s >= ds.length) return undefined;
    const e = upperBound(this.index, ds, prefix);
    if (s >= e) return undefined;
    return { datoms: ds, start: s, end: e };
  }

  /** Drop every datom with t <= maxT (after a root flip absorbed them). */
  dropThrough(maxT: number): void {
    const ds = this.flush();
    this.base = ds.filter((d) => d.t > maxT);
  }

  clear(): void {
    this.base = [];
    this.pending = [];
  }
}

/** Novelty for all four indexes. */
export class Novelty {
  readonly byIndex: Record<IndexId, SortedNovelty> = {
    0: new SortedNovelty(0),
    1: new SortedNovelty(1),
    2: new SortedNovelty(2),
    3: new SortedNovelty(3),
  };
  private _count = 0;
  private _maxT = 0;

  /**
   * Add datoms. `avet(a)` / `vaet(a)` decide which attributes participate in
   * the AVET / VAET indexes (schema-driven: `:db/index`/`:db/unique` and ref-ness).
   */
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

  /** Number of EAVT datoms held. */
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

// ---------------------------------------------------------------------------
// Merge iterator
// ---------------------------------------------------------------------------

/**
 * Merge an ordered chunk stream (from a tree scan) with a novelty chunk into
 * an ordered chunk stream. Zero-copy when novelty is empty for the range.
 */
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
    // Fast path: whole chunk sorts before remaining novelty
    if (j >= jEnd || cmp(ds[c.end - 1], nds[j]) < 0) {
      yield c;
      continue;
    }
    // Merge this chunk with the novelty that sorts before its last datom.
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
    // pull in novelty ≤ last (that would otherwise sort inside this chunk)
    while (j < jEnd && cmp(nds[j], last) <= 0) out.push(nds[j++]);
    yield { datoms: out, start: 0, end: out.length };
  }
  if (j < jEnd) yield { datoms: nds, start: j, end: jEnd };
}

// ---------------------------------------------------------------------------
// Current-view collapse
// ---------------------------------------------------------------------------

/**
 * Turn an ordered stream of history datoms into present-tense facts.
 * In every index order (E,A,V) are grouped contiguously with `t` last, so
 * consecutive datoms sharing (e,a,v) form the history of that fact; the last
 * one wins. Retracted facts are dropped. If `asOf` is given, datoms with
 * t > asOf are ignored first.
 *
 * Yields plain arrays (chunk boundaries do not align with groups, so the
 * collapse keeps one pending datom across chunks).
 */
export async function* currentView(
  chunks: AsyncIterable<Chunk>,
  asOf?: number,
): AsyncGenerator<Datom[], void, undefined> {
  let pending: Datom | undefined;
  // A whole leaf array of distinct, asserted, visible facts, held until we
  // know the next chunk does not carry a newer version of its last fact —
  // then passed through without copying.
  let held: Datom[] | undefined;
  for await (const c of chunks) {
    const ds = c.datoms;
    const start = c.start, end = c.end;
    if (start >= end) continue;
    if (held !== undefined) {
      const last = held[held.length - 1], first = ds[start];
      if (last.e === first.e && last.a === first.a && valueEquals(last.vt, last.v, first.vt, first.v)) {
        if (held.length > 1) yield held.slice(0, held.length - 1);
        pending = last; // superseded (or not) by what follows
      } else {
        yield held;
        pending = undefined;
      }
      held = undefined;
    }
    if (pending !== undefined) {
      // pending fact ends here unless this chunk continues it
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
        // hold back the last datom: the next chunk might carry a newer version of it
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
        pending = d; // newer version of same fact
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

/** True if ds[start,end) are all asserts, visible as of `asOf`, and pairwise-distinct facts. */
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

/**
 * Synchronous current-view collapse of one ordered datom array (same rules
 * as `currentView`). Used by batched seeks where each result is small.
 */
export function collapseCurrent(ds: readonly Datom[], asOf?: number): Datom[] {
  if (ds.length === 0 || isPlainChunk(ds, 0, ds.length, asOf)) return ds as Datom[]; // nothing to collapse: no copy
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

/** Filter chunks to t <= asOf without collapsing (history as-of). */
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

/** Chunks → arrays (no filtering). */
export async function* rawView(chunks: AsyncIterable<Chunk>): AsyncGenerator<Datom[], void, undefined> {
  for await (const c of chunks) {
    if (c.start === 0 && c.end === c.datoms.length) yield c.datoms as Datom[];
    else yield c.datoms.slice(c.start, c.end);
  }
}

/** Utility: does the datom match the prefix (used by tests). */
export function matchesPrefix(index: IndexId, d: Datom, p: Prefix): boolean {
  return comparePrefix(index, d, p) === 0;
}
