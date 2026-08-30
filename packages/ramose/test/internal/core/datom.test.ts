import { describe, expect, test } from "bun:test";
import {
  ALL_INDEXES,
  COMPARATORS,
  type Datom,
  Index,
  ValueTag,
  compareBytes,
  comparePrefix,
  compareStrings,
  compareValue,
  decodeValue,
  encodeF64,
  decodeF64,
  encodeI64,
  decodeI64,
  encodeValue,
  normalizeValue,
  prefixDepth,
} from "../../../src/internal/core/datom.ts";
import { randDatoms, randValue, rng, shuffle } from "./util.ts";

const utf8 = new TextEncoder();

describe("compareStrings", () => {
  test("matches UTF-8 byte order on tricky code points", () => {
    const samples = ["", "a", "ab", "b", "é", "", "�", "￿", "𝄞", "😀", "a😀", "a￿", "𐀀", "􏿿"];
    for (const x of samples) {
      for (const y of samples) {
        const expected = Math.sign(compareBytes(utf8.encode(x), utf8.encode(y)));
        expect(Math.sign(compareStrings(x, y))).toBe(expected);
      }
    }
  });
});

describe("integer / double encodings", () => {
  test("i64 round trip and order", () => {
    const vals = [0, 1, -1, 2, -2, 255, 256, -256, 2 ** 31 - 1, -(2 ** 31), 2 ** 32, -(2 ** 32), Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER];
    const enc = vals.map((v) => {
      const b = new Uint8Array(8);
      encodeI64(v, b, 0);
      expect(Number(decodeI64(b, 0))).toBe(v);
      return { v, b };
    });
    for (const x of enc) for (const y of enc) expect(Math.sign(compareBytes(x.b, y.b))).toBe(Math.sign(x.v - y.v));

    const b = new Uint8Array(8);
    encodeI64((1n << 63n) - 1n, b, 0);
    expect(decodeI64(b, 0)).toBe((1n << 63n) - 1n);
    encodeI64(-(1n << 63n), b, 0);
    expect(decodeI64(b, 0)).toBe(-(1n << 63n));
  });

  test("f64 round trip and order", () => {
    const vals = [-Infinity, -1e300, -1, -0.5, -5e-324, 0, 5e-324, 0.5, 1, 3.14, 1e300, Infinity];
    const enc = vals.map((v) => {
      const b = new Uint8Array(8);
      encodeF64(v, b, 0);
      expect(decodeF64(b, 0)).toBe(v);
      return { v, b };
    });
    for (let i = 0; i < enc.length; i++) for (let j = 0; j < enc.length; j++) expect(Math.sign(compareBytes(enc[i].b, enc[j].b))).toBe(Math.sign(i - j));

    const a = new Uint8Array(8), c = new Uint8Array(8);
    encodeF64(-0, a, 0);
    encodeF64(0, c, 0);
    expect(compareBytes(a, c)).toBe(0);
  });
});

describe("value encoding is order-preserving", () => {
  test("random values: byte order == structural order, round trip", () => {
    const r = rng(42);
    const vals: { vt: ValueTag; v: any }[] = [];
    for (let i = 0; i < 400; i++) vals.push(randValue(r));
    const encs = vals.map(({ vt, v }) => encodeValue(vt, v));
    for (let i = 0; i < vals.length; i++) {
      const d = decodeValue(encs[i]);
      expect(d.vt).toBe(vals[i].vt);
      expect(compareValue(d.vt, d.v, vals[i].vt, vals[i].v)).toBe(0);
    }
    for (let i = 0; i < vals.length; i++) {
      for (let j = 0; j < vals.length; j++) {
        const s = Math.sign(compareValue(vals[i].vt, vals[i].v, vals[j].vt, vals[j].v));
        const b = Math.sign(compareBytes(encs[i], encs[j]));
        if (s !== b) throw new Error(`mismatch ${JSON.stringify(vals[i])} vs ${JSON.stringify(vals[j])}: struct ${s} bytes ${b}`);
      }
    }
  });

  test("cross-type order follows tag", () => {
    expect(compareValue(ValueTag.Long, 999, ValueTag.Str, "")).toBeLessThan(0);
    expect(compareValue(ValueTag.Str, "zzz", ValueTag.Bool, false)).toBeLessThan(0);
    expect(compareValue(ValueTag.Ref, 1, ValueTag.Long, 1)).toBeGreaterThan(0);
  });

  test("normalizeValue rejects bad payloads", () => {
    expect(() => normalizeValue(ValueTag.Long, 1.5)).toThrow();
    expect(() => normalizeValue(ValueTag.Double, NaN)).toThrow();
    expect(() => normalizeValue(ValueTag.Uuid, "nope")).toThrow();
    expect(() => normalizeValue(ValueTag.Str, 5)).toThrow();
    expect(normalizeValue(ValueTag.Uuid, "123E4567-E89B-12D3-A456-426614174000")).toBe("123e4567-e89b-12d3-a456-426614174000");
    expect(Object.is(normalizeValue(ValueTag.Double, -0), 0)).toBe(true);
  });
});

describe("index comparators", () => {
  test("are total orders consistent with the documented component order", () => {
    const r = rng(7);
    const ds = randDatoms(r, 300);
    const key = (i: number, d: Datom): unknown[] => {
      switch (i) {
        case Index.EAVT: return [d.e, d.a, [d.vt, d.v], d.t, d.op];
        case Index.AEVT: return [d.a, d.e, [d.vt, d.v], d.t, d.op];
        case Index.AVET: return [d.a, [d.vt, d.v], d.e, d.t, d.op];
        default: return [[d.vt, d.v], d.a, d.e, d.t, d.op];
      }
    };
    const cmpKey = (x: unknown[], y: unknown[]): number => {
      for (let i = 0; i < x.length; i++) {
        const a = x[i], b = y[i];
        let c: number;
        if (Array.isArray(a)) c = compareValue(a[0] as ValueTag, a[1] as any, (b as any)[0], (b as any)[1]);
        else if (typeof a === "boolean") c = (a ? 1 : 0) - ((b as boolean) ? 1 : 0);
        else c = (a as number) < (b as number) ? -1 : (a as number) > (b as number) ? 1 : 0;
        if (c !== 0) return c;
      }
      return 0;
    };
    for (const idx of ALL_INDEXES) {
      const cmp = COMPARATORS[idx];
      for (let k = 0; k < 2000; k++) {
        const x = ds[Math.floor(r() * ds.length)], y = ds[Math.floor(r() * ds.length)];
        expect(Math.sign(cmp(x, y))).toBe(Math.sign(cmpKey(key(idx, x), key(idx, y))));
        expect(Math.sign(cmp(x, y))).toBe(0 - Math.sign(cmp(y, x)) || 0);
      }
      const sorted = shuffle(r, ds.slice()).sort(cmp);
      for (let i = 1; i < sorted.length; i++) expect(cmp(sorted[i - 1], sorted[i])).toBeLessThanOrEqual(0);
    }
  });

  test("comparePrefix agrees with full comparison for matching prefixes", () => {
    const r = rng(11);
    const ds = randDatoms(r, 200);
    for (const idx of ALL_INDEXES) {
      const cmp = COMPARATORS[idx];
      const sorted = ds.slice().sort(cmp);
      for (const d of ds) {
        const full = { e: d.e, a: d.a, vt: d.vt, v: d.v, t: d.t };
        expect(prefixDepth(idx, full)).toBe(4);
        expect(comparePrefix(idx, d, full)).toBe(0);

        for (const x of sorted) {
          const c = comparePrefix(idx, x, full);
          const f = cmp(x, d);
          if (f < 0) expect(c).toBeLessThanOrEqual(0);
          if (f > 0) expect(c).toBeGreaterThanOrEqual(0);
        }
      }

      for (const d of ds.slice(0, 20)) {
        const p = idx === Index.VAET ? { vt: d.vt, v: d.v } : idx === Index.EAVT ? { e: d.e } : { a: d.a };
        expect(prefixDepth(idx, p)).toBe(1);
        const matches = sorted.filter((x) => comparePrefix(idx, x, p) === 0);

        const first = sorted.findIndex((x) => comparePrefix(idx, x, p) === 0);
        for (let i = 0; i < matches.length; i++) expect(sorted[first + i]).toBe(matches[i]);
      }
    }
  });
});
