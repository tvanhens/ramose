/**
 * Policy eval bench (#154): reef-shaped public reads (`true` arms) and a
 * selective own-issue fragment, v1 expression vs v2 engine rule.
 *
 *   bun run bench/policy.bench.ts [issues=400]
 */
import {
  Connection,
  type Principal,
  PolicyAst as A,
  filterDb,
  parsePolicy,
  query,
} from "../packages/ramose/src/internal/core/index.ts";
import { fmt, percentile } from "./lib.ts";

const nIssues = Number(process.argv[2] ?? 400);
const nUsers = 20;

const SCHEMA = [
  { ":db/ident": ":user/sub", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/unique": ":db.unique/identity" },
  { ":db/ident": ":user/name", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one" },
  { ":db/ident": ":issue/title", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/index": true },
  { ":db/ident": ":issue/creator", ":db/valueType": ":db.type/ref", ":db/cardinality": ":db.cardinality/one" },
  { ":db/ident": ":issue/privateNote", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one" },
  { ":db/ident": ":comment/body", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one" },
  { ":db/ident": ":comment/author", ":db/valueType": ":db.type/ref", ":db/cardinality": ":db.cardinality/one" },
  { ":db/ident": ":comment/issue", ":db/valueType": ":db.type/ref", ":db/cardinality": ":db.cardinality/one" },
];

const reefV1 = parsePolicy({
  version: 1,
  principal: ":user/sub",
  classes: ["anonymous", "member", "admin"],
  attrs: { ":issue/privateNote": { read: [A.allow(A.class("admin"))] } },
  ns: {
    user: { read: [A.allow(A.const(true))] },
    issue: { read: [A.allow(A.const(true))] },
    comment: { read: [A.allow(A.const(true))] },
  },
  preset: {},
});

const reefV2 = parsePolicy({
  version: 2,
  principal: ":user/sub",
  classes: ["anonymous", "member", "admin"],
  attrs: { ":issue/privateNote": { read: [{ _tag: "allow", class: ["admin"], rule: true }] } },
  ns: {
    user: { read: [{ _tag: "allow", rule: true }] },
    issue: { read: [{ _tag: "allow", rule: true }] },
    comment: { read: [{ _tag: "allow", rule: true }] },
  },
  preset: {},
});

const ownV1 = parsePolicy({
  version: 1,
  principal: ":user/sub",
  classes: ["member", "admin"],
  attrs: {},
  ns: { issue: { read: [A.allow(A.eq(":issue/creator", A.principal))] } },
  preset: {},
});

const ownV2 = parsePolicy({
  version: 2,
  principal: ":user/sub",
  classes: ["member", "admin"],
  attrs: {},
  ns: { issue: { read: [{ _tag: "allow", rule: "policy/issue/own" }] } },
  preset: {},
  rules: [[["policy/issue/own", "?me", "?e"], ["?e", ":issue/creator", "?me"]]],
});

const conn = await Connection.create({ now: () => 1_700_000_000_000 });
await conn.transact(SCHEMA);
const users = Array.from({ length: nUsers }, (_, i) => ({
  ":db/id": `u${i}`,
  ":user/sub": `user_${i}`,
  ":user/name": `User ${i}`,
}));
const { tempids } = await conn.transact(users);
const issues = Array.from({ length: nIssues }, (_, i) => ({
  ":db/id": `i${i}`,
  ":issue/title": `Issue ${i}`,
  ":issue/creator": tempids[`u${i % nUsers}`],
  ":issue/privateNote": i % 7 === 0 ? "secret" : undefined,
}));
await conn.transact(issues.map(({ ":issue/privateNote": note, ...rest }) => (note ? { ...rest, ":issue/privateNote": note } : rest)));
const comments = Array.from({ length: nIssues * 2 }, (_, i) => ({
  ":comment/body": `c${i}`,
  ":comment/author": tempids[`u${i % nUsers}`],
  ":comment/issue": `i${i % nIssues}`,
}));
await conn.transact(comments);
const db = conn.db();
const alice: Principal = {
  kind: "user",
  class: "member",
  sub: "user_0",
  eid: tempids.u0,
  claims: { sub: "user_0" },
  db: "reef",
};

const TITLES = { find: ["?t"], where: [["?e", ":issue/title", "?t"]] };
const NOTES = { find: ["?n"], where: [["?e", ":issue/privateNote", "?n"]] };
const COMMENTS = { find: ["?b"], where: [["?e", ":comment/body", "?b"]] };

async function bench(name: string, run: () => Promise<unknown>, runs = 25) {
  const times: number[] = [];
  let rows = 0;
  for (let i = 0; i < 3; i++) await run();
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    const res = await run();
    times.push(performance.now() - t0);
    rows = Array.isArray(res) ? res.length : 1;
  }
  times.sort((a, b) => a - b);
  const p50 = percentile(times, 50);
  console.log(
    `${name.padEnd(42)} rows=${String(rows).padStart(5)}  p50 ${fmt(p50).padStart(8)} ms  p95 ${fmt(percentile(times, 95)).padStart(8)} ms`,
  );
  return { rows, p50, p95: percentile(times, 95) };
}

console.log(`dataset: ${nUsers} users, ${nIssues} issues, ${nIssues * 2} comments`);

const results: Record<string, { rows: number; p50: number; p95: number }> = {};
results["unfiltered titles"] = await bench("unfiltered titles", () => query(db, TITLES));
results["reef v1 titles (true)"] = await bench("reef v1 titles (true)", () => query(filterDb(db, db, reefV1, alice), TITLES));
results["reef v2 titles (true)"] = await bench("reef v2 titles (true)", () => query(filterDb(db, db, reefV2, alice), TITLES));
results["reef v1 comments (true)"] = await bench("reef v1 comments (true)", () => query(filterDb(db, db, reefV1, alice), COMMENTS));
results["reef v2 comments (true)"] = await bench("reef v2 comments (true)", () => query(filterDb(db, db, reefV2, alice), COMMENTS));
results["reef v1 privateNote scrub"] = await bench("reef v1 privateNote scrub", () => query(filterDb(db, db, reefV1, alice), NOTES));
results["reef v2 privateNote scrub"] = await bench("reef v2 privateNote scrub", () => query(filterDb(db, db, reefV2, alice), NOTES));
results["own v1 titles"] = await bench("own v1 titles (eq creator)", () => query(filterDb(db, db, ownV1, alice), TITLES));
results["own v2 titles"] = await bench("own v2 titles (fragment)", () => query(filterDb(db, db, ownV2, alice), TITLES));

console.log(JSON.stringify({ nUsers, nIssues, results }, null, 2));
