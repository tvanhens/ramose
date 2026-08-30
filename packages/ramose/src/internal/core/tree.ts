import { ByteReader, ByteWriter, fromHex, toHex } from "./bytes.ts";
import {
  type Datom,
  type DatomComparator,
  type IndexId,
  type Prefix,
  COMPARATORS,
  Index,
  ValueTag,
  comparePrefix,
} from "./datom.ts";
import { decodeSegment, encodeSegment, readDatom, writeDatom } from "./segment.ts";

export const NodeKind = { Leaf: 0, Dir: 1 } as const;
export type NodeKind = (typeof NodeKind)[keyof typeof NodeKind];

export interface NodeRef {
  readonly hash: string;
  readonly kind: NodeKind;
  readonly count: number;
}

export interface LeafNode {
  readonly kind: 0;
  readonly datoms: readonly Datom[];
}
export interface DirNode {
  readonly kind: 1;
  readonly keys: readonly Datom[];
  readonly refs: readonly NodeRef[];
}
export type TreeNode = LeafNode | DirNode;

export interface NodeSource {
  peek(hash: string): TreeNode | undefined;
  load(ref: NodeRef): Promise<TreeNode>;
}

export interface NodeStore extends NodeSource {
  put(index: IndexId, node: TreeNode): Promise<NodeRef>;
}

export interface BuildOptions {
  leafSize?: number;
  fanout?: number;
}
const DEFAULT_LEAF = 3000;
const DEFAULT_FANOUT = 1024;

const DIR_MAGIC = 0x52444e31;

export function encodeNode(index: IndexId, node: TreeNode): Uint8Array {
  if (node.kind === NodeKind.Leaf) return encodeSegment(index, node.datoms);
  const w = new ByteWriter(node.refs.length * 64 + 16);
  w.u32(DIR_MAGIC);
  w.u8(index);
  w.u32(node.refs.length);
  for (let i = 0; i < node.refs.length; i++) {
    const r = node.refs[i];
    w.u8(r.kind);
    w.bytes(fromHex(r.hash));
    w.uvar(r.count);
    writeDatom(w, node.keys[i]);
  }
  return w.finish();
}

export function decodeNode(buf: Uint8Array): { index: IndexId; node: TreeNode } {
  const r = new ByteReader(buf);
  const magic = r.u32();
  if (magic === DIR_MAGIC) {
    const index = r.u8() as IndexId;
    const n = r.u32();
    const keys = new Array<Datom>(n);
    const refs = new Array<NodeRef>(n);
    for (let i = 0; i < n; i++) {
      const kind = r.u8() as NodeKind;
      const hash = toHex(r.bytes(32));
      const count = r.uvar();
      keys[i] = readDatom(r);
      refs[i] = { hash, kind, count };
    }
    return { index, node: { kind: NodeKind.Dir, keys, refs } };
  }
  const seg = decodeSegment(buf);
  return { index: seg.index, node: { kind: NodeKind.Leaf, datoms: seg.datoms } };
}

export function lowerBound(index: IndexId, datoms: readonly Datom[], p: Prefix): number {
  let lo = 0, hi = datoms.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (comparePrefix(index, datoms[mid], p) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
export function upperBound(index: IndexId, datoms: readonly Datom[], p: Prefix): number {
  let lo = 0, hi = datoms.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (comparePrefix(index, datoms[mid], p) <= 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
export type PrefixCmp = (d: Datom, p: Prefix) => number;

export function prefixComparator(index: IndexId, p: Prefix): PrefixCmp {
  const hasE = p.e !== undefined, hasA = p.a !== undefined, hasV = p.vt !== undefined, hasT = p.t !== undefined;
  if (!hasV && !hasT) {
    switch (index) {
      case Index.EAVT:
        if (hasE && !hasA) return (d, q) => (d.e < q.e! ? -1 : d.e > q.e! ? 1 : 0);
        if (hasE && hasA) return (d, q) => (d.e < q.e! ? -1 : d.e > q.e! ? 1 : d.a < q.a! ? -1 : d.a > q.a! ? 1 : 0);
        break;
      case Index.AEVT:
        if (hasA && !hasE) return (d, q) => (d.a < q.a! ? -1 : d.a > q.a! ? 1 : 0);
        if (hasA && hasE) return (d, q) => (d.a < q.a! ? -1 : d.a > q.a! ? 1 : d.e < q.e! ? -1 : d.e > q.e! ? 1 : 0);
        break;
    }
  }
  return (d, q) => comparePrefix(index, d, q);
}

export function lowerBoundFrom(cmp: PrefixCmp, datoms: readonly Datom[], p: Prefix, from: number): number {
  const n = datoms.length;
  let lo = from, step = 1, hi = from;
  while (hi < n && cmp(datoms[hi], p) < 0) {
    lo = hi + 1;
    hi += step;
    step <<= 1;
  }
  if (hi > n) hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (cmp(datoms[mid], p) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
export function upperBoundFrom(cmp: PrefixCmp, datoms: readonly Datom[], p: Prefix, from: number): number {
  const n = datoms.length;
  let lo = from, step = 1, hi = from;
  while (hi < n && cmp(datoms[hi], p) <= 0) {
    lo = hi + 1;
    hi += step;
    step <<= 1;
  }
  if (hi > n) hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (cmp(datoms[mid], p) <= 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
export function lowerBoundDatom(cmp: DatomComparator, datoms: readonly Datom[], d: Datom): number {
  let lo = 0, hi = datoms.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (cmp(datoms[mid], d) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function childForPrefix(index: IndexId, dir: DirNode, p: Prefix): number {
  const keys = dir.keys;
  let lo = 0, hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (comparePrefix(index, keys[mid], p) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo === 0 ? 0 : lo - 1;
}

async function getNode(src: NodeSource, ref: NodeRef): Promise<TreeNode> {
  const n = src.peek(ref.hash);
  return n !== undefined ? n : src.load(ref);
}

export interface Chunk {
  readonly datoms: readonly Datom[];
  readonly start: number;
  readonly end: number;
}

export async function* scan(
  src: NodeSource,
  index: IndexId,
  root: NodeRef,
  prefix: Prefix,
): AsyncGenerator<Chunk, void, undefined> {
  const dirs: DirNode[] = [];
  const idxs: number[] = [];
  let ref: NodeRef = root;
  for (;;) {
    let node = src.peek(ref.hash);
    if (node === undefined) node = await src.load(ref);
    if (node.kind === NodeKind.Leaf) {
      const ds = node.datoms;
      const s = lowerBound(index, ds, prefix);
      if (s < ds.length) {
        const e = upperBound(index, ds, prefix);
        if (s < e) yield { datoms: ds, start: s, end: e };
        if (e < ds.length) return;
      }
      break;
    }
    const i = childForPrefix(index, node, prefix);
    dirs.push(node);
    idxs.push(i + 1);
    ref = node.refs[i];
  }
  for (;;) {
    while (dirs.length > 0 && idxs[idxs.length - 1] >= dirs[dirs.length - 1].refs.length) {
      dirs.pop();
      idxs.pop();
    }
    if (dirs.length === 0) return;
    const d = dirs[dirs.length - 1];
    const i = idxs[idxs.length - 1]++;
    if (comparePrefix(index, d.keys[i], prefix) > 0) return;
    let child = src.peek(d.refs[i].hash);
    if (child === undefined) child = await src.load(d.refs[i]);
    while (child.kind === NodeKind.Dir) {
      dirs.push(child);
      idxs.push(1);
      const cref: NodeRef = child.refs[0];
      const c = src.peek(cref.hash);
      child = c !== undefined ? c : await src.load(cref);
    }
    const ds = child.datoms;
    const e = upperBound(index, ds, prefix);
    if (e > 0) yield { datoms: ds, start: 0, end: e };
    if (e < ds.length) return;
  }
}

export async function scanMany(
  src: NodeSource,
  index: IndexId,
  root: NodeRef,
  prefixes: readonly Prefix[],
): Promise<Datom[][]> {
  const results: Datom[][] = new Array(prefixes.length);
  if (prefixes.length === 0) return results;
  const asDatom = prefixes.map(prefixAsDatom);
  const order = sortedPrefixOrder(index, prefixes, asDatom);
  const pcmp = prefixComparator(index, prefixes[0]);

  const dirs: DirNode[] = [];
  const idxs: number[] = [];
  let leaf: LeafNode | undefined;

  const descend = async (p: Prefix): Promise<void> => {
    dirs.length = 0;
    idxs.length = 0;
    let ref: NodeRef = root;
    for (;;) {
      let node = src.peek(ref.hash);
      if (node === undefined) node = await src.load(ref);
      if (node.kind === NodeKind.Leaf) {
        leaf = node;
        return;
      }
      const i = childForPrefix(index, node, p);
      dirs.push(node);
      idxs.push(i + 1);
      ref = node.refs[i];
    }
  };
  const nextLeaf = async (p: Prefix): Promise<LeafNode | undefined> => {
    for (;;) {
      while (dirs.length > 0 && idxs[idxs.length - 1] >= dirs[dirs.length - 1].refs.length) {
        dirs.pop();
        idxs.pop();
      }
      if (dirs.length === 0) return undefined;
      const d = dirs[dirs.length - 1];
      const i = idxs[idxs.length - 1]++;
      if (comparePrefix(index, d.keys[i], p) > 0) {
        idxs[idxs.length - 1]--;
        return undefined;
      }
      let child = src.peek(d.refs[i].hash);
      if (child === undefined) child = await src.load(d.refs[i]);
      while (child.kind === NodeKind.Dir) {
        dirs.push(child);
        idxs.push(1);
        const cref: NodeRef = child.refs[0];
        const c = src.peek(cref.hash);
        child = c !== undefined ? c : await src.load(cref);
      }
      return child;
    }
  };

  let prevP: Prefix | undefined;
  let prevOut: Datom[] = [];
  let lastDs: readonly Datom[] | undefined;
  let lastEnd = 0;
  for (const i of order) {
    const p = prefixes[i];
    if (prevP !== undefined && pcmp(asDatom[i], prevP) === 0) {
      results[i] = prevOut;
      continue;
    }
    let ds: readonly Datom[];
    if (leaf === undefined || leaf.datoms.length === 0 || pcmp(leaf.datoms[leaf.datoms.length - 1], p) < 0) {
      await descend(p);
      ds = leaf!.datoms;
    } else {
      ds = leaf.datoms;
    }
    const out: Datom[] = [];
    let s = lowerBoundFrom(pcmp, ds, p, ds === lastDs ? lastEnd : 0);
    for (;;) {
      const e = upperBoundFrom(pcmp, ds, p, s);
      for (let k = s; k < e; k++) out.push(ds[k]);
      lastDs = ds;
      lastEnd = e;
      if (e < ds.length) break;
      const nl = await nextLeaf(p);
      if (nl === undefined) break;
      leaf = nl;
      ds = nl.datoms;
      s = 0;
    }
    prevP = p;
    prevOut = out;
    results[i] = out;
  }
  return results;
}

function sortedPrefixOrder(index: IndexId, prefixes: readonly Prefix[], asDatom: readonly Datom[]): number[] {
  const n = prefixes.length;
  const cmp = (x: number, y: number) => comparePrefix(index, asDatom[x], prefixes[y]);
  const order: number[] = new Array(n);
  const LIMIT = 2 ** 32;
  if (n < 2 ** 20) {
    const packed = new Float64Array(n);
    let ok = true;
    for (let i = 0; i < n; i++) {
      const p = prefixes[i];
      let k: unknown;
      switch (index) {
        case Index.EAVT: k = p.e; break;
        case Index.AEVT: case Index.AVET: k = p.a; break;
        default: k = p.vt === ValueTag.Ref ? p.v : undefined; break;
      }
      if (typeof k !== "number" || !(k >= 0 && k < LIMIT) || !Number.isInteger(k)) { ok = false; break; }
      packed[i] = k * 2 ** 20 + i;
    }
    if (ok) {
      packed.sort();
      for (let i = 0; i < n; i++) order[i] = packed[i] % 2 ** 20;
      let i = 0;
      while (i < n) {
        let j = i + 1;
        const ki = Math.floor(packed[i] / 2 ** 20);
        while (j < n && Math.floor(packed[j] / 2 ** 20) === ki) j++;
        if (j - i > 1) {
          const run = order.slice(i, j).sort(cmp);
          for (let k = 0; k < run.length; k++) order[i + k] = run[k];
        }
        i = j;
      }
      return order;
    }
  }
  for (let i = 0; i < n; i++) order[i] = i;
  return order.sort(cmp);
}

function prefixAsDatom(p: Prefix): Datom {
  return { e: p.e ?? 0, a: p.a ?? 0, vt: (p.vt ?? 0) as Datom["vt"], v: (p.v ?? 0) as Datom["v"], t: p.t ?? 0, op: true };
}

export async function seekOne(
  src: NodeSource,
  index: IndexId,
  root: NodeRef,
  prefix: Prefix,
): Promise<Datom | undefined> {
  for await (const c of scan(src, index, root, prefix)) {
    return c.datoms[c.start];
  }
  return undefined;
}

export async function collect(
  src: NodeSource,
  index: IndexId,
  root: NodeRef,
  prefix: Prefix,
): Promise<Datom[]> {
  const out: Datom[] = [];
  for await (const c of scan(src, index, root, prefix)) {
    for (let i = c.start; i < c.end; i++) out.push(c.datoms[i]);
  }
  return out;
}

export async function estimateCount(
  src: NodeSource,
  index: IndexId,
  root: NodeRef,
  prefix: Prefix,
): Promise<number> {
  let node = await getNode(src, root);
  if (node.kind === NodeKind.Leaf) {
    return upperBound(index, node.datoms, prefix) - lowerBound(index, node.datoms, prefix);
  }
  let total = 0;
  let leftDir: DirNode | undefined = node;
  let rightDir: DirNode | undefined = node;
  let li = 0, ri = 0;
  const locate = (d: DirNode): [number, number] => {
    const first = childForPrefix(index, d, prefix);
    let lo = first, hi = d.keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (comparePrefix(index, d.keys[mid], prefix) <= 0) lo = mid + 1;
      else hi = mid;
    }
    return [first, Math.max(first, lo - 1)];
  };
  [li, ri] = locate(node);
  if (li === ri) {
    let ref = node.refs[li];
    for (;;) {
      const n = await getNode(src, ref);
      if (n.kind === NodeKind.Leaf) {
        return upperBound(index, n.datoms, prefix) - lowerBound(index, n.datoms, prefix);
      }
      const [a, b] = locate(n);
      if (a !== b) {
        leftDir = n;
        rightDir = n;
        li = a;
        ri = b;
        break;
      }
      ref = n.refs[a];
    }
  }
  for (let i = li + 1; i < ri; i++) total += leftDir!.refs[i].count;
  let lref = leftDir!.refs[li];
  for (;;) {
    const n = await getNode(src, lref);
    if (n.kind === NodeKind.Leaf) {
      total += n.datoms.length - lowerBound(index, n.datoms, prefix);
      break;
    }
    const c = childForPrefix(index, n, prefix);
    for (let i = c + 1; i < n.refs.length; i++) total += n.refs[i].count;
    lref = n.refs[c];
  }
  let rref = rightDir!.refs[ri];
  for (;;) {
    const n = await getNode(src, rref);
    if (n.kind === NodeKind.Leaf) {
      total += upperBound(index, n.datoms, prefix);
      break;
    }
    let lo = 0, hi = n.keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (comparePrefix(index, n.keys[mid], prefix) <= 0) lo = mid + 1;
      else hi = mid;
    }
    const c = Math.max(0, lo - 1);
    for (let i = 0; i < c; i++) total += n.refs[i].count;
    rref = n.refs[c];
  }
  return total;
}

interface Entry {
  key: Datom;
  ref: NodeRef;
}

async function buildLevels(
  store: NodeStore,
  index: IndexId,
  entries: Entry[],
  fanout: number,
): Promise<NodeRef> {
  let level = entries;
  while (level.length > 1) {
    const next: Entry[] = [];
    const groups = Math.ceil(level.length / fanout);
    const per = Math.ceil(level.length / groups);
    for (let g = 0; g < level.length; g += per) {
      const slice = level.slice(g, g + per);
      const dir: DirNode = {
        kind: NodeKind.Dir,
        keys: slice.map((e) => e.key),
        refs: slice.map((e) => e.ref),
      };
      const ref = await store.put(index, dir);
      next.push({ key: slice[0].key, ref });
    }
    level = next;
  }
  return level[0].ref;
}

export async function buildTree(
  store: NodeStore,
  index: IndexId,
  sorted: readonly Datom[],
  opts: BuildOptions = {},
): Promise<NodeRef> {
  const leafSize = opts.leafSize ?? DEFAULT_LEAF;
  const fanout = opts.fanout ?? DEFAULT_FANOUT;
  if (sorted.length === 0) {
    return store.put(index, { kind: NodeKind.Leaf, datoms: [] });
  }
  const entries: Entry[] = [];
  const nLeaves = Math.ceil(sorted.length / leafSize);
  const per = Math.ceil(sorted.length / nLeaves);
  for (let i = 0; i < sorted.length; i += per) {
    const datoms = sorted.slice(i, i + per);
    const ref = await store.put(index, { kind: NodeKind.Leaf, datoms });
    entries.push({ key: datoms[0], ref });
  }
  return buildLevels(store, index, entries, fanout);
}

export function sortedUnion(cmp: DatomComparator, a: readonly Datom[], b: readonly Datom[]): Datom[] {
  const out: Datom[] = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    const c = cmp(a[i], b[j]);
    if (c < 0) out.push(a[i++]);
    else if (c > 0) out.push(b[j++]);
    else {
      out.push(a[i++]);
      j++;
    }
  }
  while (i < a.length) out.push(a[i++]);
  while (j < b.length) out.push(b[j++]);
  return out;
}

async function mergeNode(
  store: NodeStore,
  index: IndexId,
  cmp: DatomComparator,
  ref: NodeRef,
  key: Datom | undefined,
  novelty: readonly Datom[],
  lo: number,
  hi: number,
  leafSize: number,
  fanout: number,
): Promise<Entry[]> {
  if (lo >= hi) return [{ key: key!, ref }];
  const node = await getNode(store, ref);
  if (node.kind === NodeKind.Leaf) {
    const merged = sortedUnion(cmp, node.datoms, novelty.slice(lo, hi));
    if (merged.length === node.datoms.length) return [{ key: key ?? node.datoms[0], ref }];
    const maxLeaf = Math.floor(leafSize * 1.5);
    const out: Entry[] = [];
    if (merged.length <= maxLeaf) {
      const r = await store.put(index, { kind: NodeKind.Leaf, datoms: merged });
      out.push({ key: merged[0], ref: r });
    } else {
      const parts = Math.ceil(merged.length / leafSize);
      const per = Math.ceil(merged.length / parts);
      for (let i = 0; i < merged.length; i += per) {
        const datoms = merged.slice(i, i + per);
        const r = await store.put(index, { kind: NodeKind.Leaf, datoms });
        out.push({ key: datoms[0], ref: r });
      }
    }
    return out;
  }
  const keys = node.keys;
  const n = keys.length;
  const children: Entry[] = [];
  let changed = false;
  let start = lo;
  for (let i = 0; i < n; i++) {
    let end: number;
    if (i + 1 < n) {
      let l = start, h = hi;
      const k = keys[i + 1];
      while (l < h) {
        const mid = (l + h) >>> 1;
        if (cmp(novelty[mid], k) < 0) l = mid + 1;
        else h = mid;
      }
      end = l;
    } else {
      end = hi;
    }
    if (start < end) {
      const sub = await mergeNode(store, index, cmp, node.refs[i], keys[i], novelty, start, end, leafSize, fanout);
      if (sub.length !== 1 || sub[0].ref.hash !== node.refs[i].hash) changed = true;
      for (const e of sub) children.push(e);
    } else {
      children.push({ key: keys[i], ref: node.refs[i] });
    }
    start = end;
  }
  if (!changed) return [{ key: key ?? keys[0], ref }];
  const out: Entry[] = [];
  const groups = Math.ceil(children.length / fanout);
  const per = Math.ceil(children.length / groups);
  for (let g = 0; g < children.length; g += per) {
    const slice = children.slice(g, g + per);
    const dir: DirNode = {
      kind: NodeKind.Dir,
      keys: slice.map((e) => e.key),
      refs: slice.map((e) => e.ref),
    };
    const r = await store.put(index, dir);
    out.push({ key: slice[0].key, ref: r });
  }
  return out;
}

export async function mergeTree(
  store: NodeStore,
  index: IndexId,
  root: NodeRef,
  novelty: readonly Datom[],
  opts: BuildOptions = {},
): Promise<NodeRef> {
  if (novelty.length === 0) return root;
  const leafSize = opts.leafSize ?? DEFAULT_LEAF;
  const fanout = opts.fanout ?? DEFAULT_FANOUT;
  const cmp = COMPARATORS[index];
  const entries = await mergeNode(store, index, cmp, root, undefined, novelty, 0, novelty.length, leafSize, fanout);
  if (entries.length === 1) return entries[0].ref;
  return buildLevels(store, index, entries, fanout);
}

export async function treeDepth(src: NodeSource, root: NodeRef): Promise<number> {
  let d = 1;
  let ref = root;
  for (;;) {
    const n = await getNode(src, ref);
    if (n.kind === NodeKind.Leaf) return d;
    d++;
    ref = n.refs[0];
  }
}

export async function reachable(src: NodeSource, root: NodeRef, into: Set<string> = new Set()): Promise<Set<string>> {
  const stack: NodeRef[] = [root];
  while (stack.length) {
    const r = stack.pop()!;
    if (into.has(r.hash)) continue;
    into.add(r.hash);
    if (r.kind === NodeKind.Dir) {
      const n = await getNode(src, r);
      if (n.kind === NodeKind.Dir) for (const c of n.refs) stack.push(c);
    }
  }
  return into;
}
