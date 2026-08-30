import { Connection } from "../packages/ramose/src/internal/core/index.ts";
import { fmt } from "./lib.ts";

const N = Number(process.argv[2] ?? 5000);
const conn = await Connection.create();
await conn.transact([
  { ":db/ident": ":person/name", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/index": true },
  { ":db/ident": ":person/email", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/unique": ":db.unique/identity" },
  { ":db/ident": ":person/age", ":db/valueType": ":db.type/long", ":db/cardinality": ":db.cardinality/one" },
]);

let t0 = performance.now();
for (let i = 0; i < N; i++) {
  await conn.transact([{ ":person/name": `p${i}`, ":person/email": `p${i}@x`, ":person/age": i % 90 }]);
}
let ms = performance.now() - t0;
console.log(`sequential small txs (3 datoms + upsert check): ${N} tx in ${fmt(ms, 0)} ms → ${fmt((N / ms) * 1000, 0)} tx/s`);

t0 = performance.now();
await Promise.all(Array.from({ length: N }, (_, i) => conn.transact([[":db/add", [":person/email", `p${i}@x`], ":person/age", (i + 1) % 90]])));
ms = performance.now() - t0;
console.log(`concurrent updates via lookup ref:              ${N} tx in ${fmt(ms, 0)} ms → ${fmt((N / ms) * 1000, 0)} tx/s`);

t0 = performance.now();
await conn.index();
ms = performance.now() - t0;
console.log(`index() merge of ${N * 2} txs of novelty into trees: ${fmt(ms, 0)} ms`);

t0 = performance.now();
for (let i = 0; i < N; i++) {
  await conn.transact([[":db/add", [":person/email", `p${i}@x`], ":person/age", (i + 2) % 90]]);
}
ms = performance.now() - t0;
console.log(`sequential updates after indexing:              ${N} tx in ${fmt(ms, 0)} ms → ${fmt((N / ms) * 1000, 0)} tx/s`);
