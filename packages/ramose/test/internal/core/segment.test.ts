import { describe, expect, test } from "bun:test";
import { gunzip, gzip, sha256Hex, ByteReader, ByteWriter } from "../../../src/internal/core/bytes.ts";
import { COMPARATORS, Index, datomEquals } from "../../../src/internal/core/datom.ts";
import { decodeSegment, encodeSegment } from "../../../src/internal/core/segment.ts";
import { NodeKind, decodeNode, encodeNode } from "../../../src/internal/core/tree.ts";
import { randDatoms, rng } from "./util.ts";

describe("bytes", () => {
  test("varints round trip", () => {
    const w = new ByteWriter(4);
    const vals = [0, 1, 127, 128, 255, 256, 16383, 16384, 2 ** 32, Number.MAX_SAFE_INTEGER];
    for (const v of vals) w.uvar(v);
    const svals = [0, -1, 1, -128, 127, -(2 ** 40), 2 ** 40, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER];
    for (const v of svals) w.svar(v);
    w.str("héllo 😀");
    const r = new ByteReader(w.finish());
    for (const v of vals) expect(r.uvar()).toBe(v);
    for (const v of svals) expect(r.svar()).toBe(v);
    expect(r.str()).toBe("héllo 😀");
    expect(r.remaining).toBe(0);
  });

  test("gzip round trip + sha256", async () => {
    const data = new TextEncoder().encode("ramose ".repeat(1000));
    const z = await gzip(data);
    expect(z.length).toBeLessThan(data.length);
    expect(await gunzip(z)).toEqual(data);
    expect(await sha256Hex(new Uint8Array(0))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});

describe("segment codec", () => {
  test("round trips random sorted datoms in every index order", () => {
    const r = rng(3);
    for (const idx of [Index.EAVT, Index.AEVT, Index.AVET, Index.VAET] as const) {
      const ds = randDatoms(r, 3000).sort(COMPARATORS[idx]);
      const buf = encodeSegment(idx, ds);
      const dec = decodeSegment(buf);
      expect(dec.index).toBe(idx);
      expect(dec.datoms.length).toBe(ds.length);
      for (let i = 0; i < ds.length; i++) {
        if (!datomEquals(dec.datoms[i], ds[i])) throw new Error(`mismatch at ${i}: ${JSON.stringify(dec.datoms[i])} vs ${JSON.stringify(ds[i])}`);
      }
    }
  });

  test("empty segment", () => {
    const dec = decodeSegment(encodeSegment(Index.EAVT, []));
    expect(dec.datoms).toEqual([]);
  });

  test("encoding is deterministic (content addressing)", async () => {
    const r = rng(9);
    const ds = randDatoms(r, 500).sort(COMPARATORS[Index.EAVT]);
    const a = encodeSegment(Index.EAVT, ds);
    const b = encodeSegment(Index.EAVT, ds.map((d) => ({ ...d })));
    expect(await sha256Hex(a)).toBe(await sha256Hex(b));
  });

  test("dir node codec round trips", () => {
    const r = rng(5);
    const ds = randDatoms(r, 50).sort(COMPARATORS[Index.AVET]);
    const refs = ds.map((_, i) => ({ hash: "ab".repeat(32), kind: (i % 2) as 0 | 1, count: i * 3 }));
    const buf = encodeNode(Index.AVET, { kind: NodeKind.Dir, keys: ds, refs });
    const { index, node } = decodeNode(buf);
    expect(index).toBe(Index.AVET);
    expect(node.kind).toBe(NodeKind.Dir);
    if (node.kind === NodeKind.Dir) {
      expect(node.refs).toEqual(refs);
      for (let i = 0; i < ds.length; i++) expect(datomEquals(node.keys[i], ds[i])).toBe(true);
    }

    const leaf = decodeNode(encodeNode(Index.EAVT, { kind: NodeKind.Leaf, datoms: ds }));
    expect(leaf.node.kind).toBe(NodeKind.Leaf);
  });
});
