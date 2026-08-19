/**
 * Shared bench helpers: build a 1M-datom in-memory Ramose database.
 */
import {
  Connection,
  type Datom,
  FIRST_USER_EID,
  ValueTag,
  attributeDatoms,
} from "../packages/ramose/src/internal/core/index.ts";

export const ATTR = {
  name: FIRST_USER_EID,
  email: FIRST_USER_EID + 1,
  age: FIRST_USER_EID + 2,
  city: FIRST_USER_EID + 3,
  score: FIRST_USER_EID + 4,
  active: FIRST_USER_EID + 5,
  joined: FIRST_USER_EID + 6,
  friends: FIRST_USER_EID + 7,
};

export function schemaDatoms(t = 2): Datom[] {
  return [
    ...attributeDatoms(ATTR.name, { ident: ":person/name", valueType: ":db.type/string", index: true }, t),
    ...attributeDatoms(ATTR.email, { ident: ":person/email", valueType: ":db.type/string", unique: "identity" }, t),
    ...attributeDatoms(ATTR.age, { ident: ":person/age", valueType: ":db.type/long" }, t),
    ...attributeDatoms(ATTR.city, { ident: ":person/city", valueType: ":db.type/string", index: true }, t),
    ...attributeDatoms(ATTR.score, { ident: ":person/score", valueType: ":db.type/double" }, t),
    ...attributeDatoms(ATTR.active, { ident: ":person/active", valueType: ":db.type/boolean" }, t),
    ...attributeDatoms(ATTR.joined, { ident: ":person/joined", valueType: ":db.type/instant" }, t),
    ...attributeDatoms(ATTR.friends, { ident: ":person/friends", valueType: ":db.type/ref", cardinality: "many" }, t),
  ];
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const FIRST_PERSON = FIRST_USER_EID + 100;
export const N_CITIES = 10;

/** ~10 datoms per person → `people` people ≈ 10·people datoms. */
export function generateDatoms(people: number, seed = 1): Datom[] {
  const r = mulberry32(seed);
  const out: Datom[] = schemaDatoms(2);
  const t0 = 3;
  for (let i = 0; i < people; i++) {
    const e = FIRST_PERSON + i;
    const t = t0 + (i % 1000); // spread over 1000 txs
    out.push({ e, a: ATTR.name, vt: ValueTag.Str, v: `person-${i}`, t, op: true });
    out.push({ e, a: ATTR.email, vt: ValueTag.Str, v: `p${i}@example.com`, t, op: true });
    out.push({ e, a: ATTR.age, vt: ValueTag.Long, v: Math.floor(r() * 90), t, op: true });
    out.push({ e, a: ATTR.city, vt: ValueTag.Str, v: `city-${i % N_CITIES}`, t, op: true });
    out.push({ e, a: ATTR.score, vt: ValueTag.Double, v: Math.round(r() * 10000) / 100, t, op: true });
    out.push({ e, a: ATTR.active, vt: ValueTag.Bool, v: r() < 0.7, t, op: true });
    out.push({ e, a: ATTR.joined, vt: ValueTag.Inst, v: 1_500_000_000_000 + Math.floor(r() * 1e11), t, op: true });
    for (let k = 0; k < 3; k++) {
      const f = FIRST_PERSON + Math.floor(r() * people);
      if (f !== e) out.push({ e, a: ATTR.friends, vt: ValueTag.Ref, v: f, t, op: true });
    }
  }
  return out;
}

export async function buildBenchDb(people = 100_000, opts: { leafSize?: number; fanout?: number } = {}) {
  const t0 = performance.now();
  const datoms = generateDatoms(people);
  const tGen = performance.now();
  const conn = await Connection.fromDatoms(datoms, { build: { leafSize: opts.leafSize ?? 3000, fanout: opts.fanout ?? 1024 } });
  const tBuild = performance.now();
  return { conn, datoms, people, genMs: tGen - t0, buildMs: tBuild - tGen };
}

export function fmt(n: number, digits = 2): string {
  return n.toFixed(digits);
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}
