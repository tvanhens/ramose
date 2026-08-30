import { Index, seekOne, ValueTag } from "../packages/ramose/src/internal/core/index.ts";
import { ATTR, FIRST_PERSON, buildBenchDb, fmt, mulberry32, percentile } from "./lib.ts";

const people = Number(process.argv[2] ?? 100_000);
const { conn, datoms, genMs, buildMs } = await buildBenchDb(people);
const db = conn.db();
console.log(`dataset: ${datoms.length.toLocaleString()} datoms, ${people.toLocaleString()} people — generate ${fmt(genMs, 0)} ms, build trees ${fmt(buildMs, 0)} ms`);
console.log(`roots: eavt=${db.roots.eavt.count} aevt=${db.roots.aevt.count} avet=${db.roots.avet.count} vaet=${db.roots.vaet.count}`);

const r = mulberry32(7);
const ITER = 200_000;
const targets = Array.from({ length: ITER }, () => FIRST_PERSON + Math.floor(r() * people));

async function bench(name: string, fn: (i: number) => Promise<unknown>, iters = ITER) {

  for (let i = 0; i < 20_000; i++) await fn(i);
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) await fn(i);
  const total = performance.now() - t0;
  const per = (total * 1000) / iters;

  const samples: number[] = [];
  for (let i = 0; i < 20_000; i++) {
    const s = performance.now();
    await fn(i);
    samples.push((performance.now() - s) * 1000);
  }
  samples.sort((a, b) => a - b);
  console.log(`${name.padEnd(46)} ${fmt(per, 2).padStart(8)} µs/op   p50 ${fmt(percentile(samples, 50), 2)} µs  p99 ${fmt(percentile(samples, 99), 2)} µs`);
  return per;
}

const results: Record<string, number> = {};
results["tree seekOne EAVT (e)"] = await bench("tree.seekOne EAVT prefix {e}", (i) => seekOne(db.store, Index.EAVT, db.roots.eavt, { e: targets[i] }));
results["tree seekOne EAVT (e,a)"] = await bench("tree.seekOne EAVT prefix {e,a}", (i) => seekOne(db.store, Index.EAVT, db.roots.eavt, { e: targets[i], a: ATTR.name }));
results["tree seekOne AVET (a,v)"] = await bench("tree.seekOne AVET {a: name, v}", (i) => seekOne(db.store, Index.AVET, db.roots.avet, { a: ATTR.name, vt: ValueTag.Str, v: `person-${targets[i] - FIRST_PERSON}` }));
results["tree seekOne VAET (v,a)"] = await bench("tree.seekOne VAET {v: ref, a: friends}", (i) => seekOne(db.store, Index.VAET, db.roots.vaet, { vt: ValueTag.Ref, v: targets[i], a: ATTR.friends }));
results["db.first EAVT (e,a) current view"] = await bench("db.first EAVT {e,a} (merge + current view)", (i) => db.first(Index.EAVT, { e: targets[i], a: ATTR.age }));
results["db.datomsArray EAVT (e) entity"] = await bench("db.datomsArray EAVT {e} (whole entity ~10)", (i) => db.datomsArray(Index.EAVT, { e: targets[i] }));
results["db.entid lookup ref (email)"] = await bench("db.entid [:person/email x] (AVET seek)", (i) => db.entid([":person/email", `p${targets[i] - FIRST_PERSON}@example.com`]), 50_000);

const worst = Math.max(...Object.values(results).slice(0, 4));
console.log(`\nM1 gate: single seek < 10 µs warm → ${worst < 10 ? "PASS" : "FAIL"} (worst raw seek ${fmt(worst)} µs)`);
console.log(JSON.stringify({ people, datoms: datoms.length, results }, null, 2));
