/**
 * M1 bench: 3-clause join over ~10k intermediate rows on a 1M-datom db.
 * Target: < 50 ms in Bun.
 *
 *   bun run bench/join.bench.ts [people=100000]
 */
import { type QueryStats, query } from "../packages/ramose/src/internal/core/index.ts";
import { buildBenchDb, fmt, percentile } from "./lib.ts";

const people = Number(process.argv[2] ?? 100_000);
const { conn, datoms, buildMs } = await buildBenchDb(people);
const db = conn.db();
console.log(`dataset: ${datoms.length.toLocaleString()} datoms (build ${fmt(buildMs, 0)} ms)`);

// city-3 has people/10 = 10k entities (for 100k people) → clause 1 yields 10k rows,
// clause 2 expands to ~30k (3 friends each), clause 3 looks up 30k names.
const Q3 = `[:find ?n ?fn
             :where [?e :person/city "city-3"]
                    [?e :person/friends ?f]
                    [?f :person/name ?fn]
                    [?e :person/name ?n]]`;
// A pure 3-clause variant (as in the spec): city → friends → friend name
const Q3b = `[:find ?e ?fn
              :where [?e :person/city "city-3"]
                     [?e :person/friends ?f]
                     [?f :person/name ?fn]]`;
// Aggregate over the same join
const QAgg = `[:find (count ?f) . :where [?e :person/city "city-3"] [?e :person/friends ?f] [?f :person/active true]]`;
// Input-driven seek join: 10k entity ids in, friend names out
const QIn = `[:find ?e ?fn :in $ [?e ...] :where [?e :person/friends ?f] [?f :person/name ?fn]]`;

async function bench(name: string, q: string, inputs: unknown[] = [], runs = 15) {
  const times: number[] = [];
  let rows = 0;
  let stats: QueryStats | undefined;
  for (let i = 0; i < runs; i++) {
    stats = { clauses: [] };
    const t0 = performance.now();
    const res = await query(db, q, inputs, { stats });
    times.push(performance.now() - t0);
    rows = Array.isArray(res) ? res.length : 1;
  }
  times.sort((a, b) => a - b);
  console.log(`${name.padEnd(28)} rows=${String(rows).padStart(6)}  min ${fmt(times[0]).padStart(8)} ms  p50 ${fmt(percentile(times, 50)).padStart(8)} ms  max ${fmt(times[times.length - 1]).padStart(8)} ms`);
  for (const c of stats!.clauses) console.log(`    ${c.strategy.padEnd(10)} ${(c.index ?? "").padEnd(5)} in=${c.rowsIn} out=${c.rowsOut} seeks=${c.seeks} scanned=${c.scanned} ${fmt(c.ms)}ms  ${c.clause}`);
  return percentile(times, 50);
}

const inputIds = (await query(db, `[:find [?e ...] :where [?e :person/city "city-3"]]`)) as number[];
console.log(`city-3 has ${inputIds.length} people`);

const results: Record<string, number> = {};
results["3-clause city→friends→name"] = await bench("3-clause (Q3b)", Q3b);
results["4-clause with both names"] = await bench("4-clause (Q3)", Q3);
results["3-clause aggregate"] = await bench("3-clause count (QAgg)", QAgg);
results["input-driven 2-clause"] = await bench("input ids → names (QIn)", QIn, [inputIds]);

const gate = results["3-clause city→friends→name"];
console.log(`\nM1 gate: 3-clause join over ~10k intermediate rows < 50 ms → ${gate < 50 ? "PASS" : "FAIL"} (p50 ${fmt(gate)} ms)`);
console.log(JSON.stringify({ people, datoms: datoms.length, results }, null, 2));
