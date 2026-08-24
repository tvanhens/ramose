/**
 * Property test: datalog results ≡ a naive reference evaluator over the raw
 * current-view datom list, on random data, with novelty both un-indexed and
 * merged into trees (small nodes so trees are deep).
 */
import { describe, expect, test } from "bun:test";
import { Connection } from "../../../src/internal/core/conn.ts";
import { Index } from "../../../src/internal/core/datom.ts";
import { datomJsValue } from "../../../src/internal/core/db.ts";
import { query } from "../../../src/internal/core/query/engine.ts";
import { vkey } from "../../../src/internal/core/query/builtins.ts";
import { pick, randInt, rng } from "./util.ts";

const SCHEMA = [
  { ":db/ident": ":p/name", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/index": true, ":db/optional": true },
  { ":db/ident": ":p/age", ":db/valueType": ":db.type/long", ":db/cardinality": ":db.cardinality/one", ":db/optional": true },
  { ":db/ident": ":p/tag", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/many" },
  { ":db/ident": ":p/friend", ":db/valueType": ":db.type/ref", ":db/cardinality": ":db.cardinality/many" },
  { ":db/ident": ":p/boss", ":db/valueType": ":db.type/ref", ":db/cardinality": ":db.cardinality/one", ":db/optional": true },
  { ":db/ident": ":p/flag", ":db/valueType": ":db.type/boolean", ":db/cardinality": ":db.cardinality/one", ":db/optional": true },
];
const ATTRS = [":p/name", ":p/age", ":p/tag", ":p/friend", ":p/boss", ":p/flag"];
const NAMES = ["ann", "bo", "cy", "di", "ed"];
const TAGS = ["x", "y", "z"];

type Fact = { e: number; a: number; v: unknown };
type Pattern = [unknown, unknown, unknown];

function naive(facts: Fact[], patterns: Pattern[], findVars: string[]): Set<string> {
  const results = new Set<string>();
  const isVar = (x: unknown) => typeof x === "string" && x.startsWith("?");
  const step = (i: number, env: Map<string, unknown>) => {
    if (i === patterns.length) {
      results.add(findVars.map((v) => vkey(env.get(v))).join("|"));
      return;
    }
    const [E, A, V] = patterns[i];
    for (const f of facts) {
      const env2 = new Map(env);
      const unify = (term: unknown, val: unknown): boolean => {
        if (term === "_") return true;
        if (isVar(term)) {
          const cur = env2.get(term as string);
          if (cur === undefined) {
            env2.set(term as string, val);
            return true;
          }
          return vkey(cur) === vkey(val);
        }
        return vkey(term) === vkey(val);
      };
      if (!unify(E, f.e)) continue;
      if (!unify(A, f.a)) continue;
      if (!unify(V, f.v)) continue;
      step(i + 1, env2);
    }
  };
  step(0, new Map());
  return results;
}

describe("query ≡ naive reference on random data", () => {
  // Seeded; isolation is ~2s, but a contended suite has timed out at bun's
  // 5s default (5246ms). Give the property run room.
  test("random conjunctive queries, before and after indexing", async () => {
    const r = rng(2024);
    const conn = await Connection.create({ build: { leafSize: 8, fanout: 4 } });
    await conn.transact(SCHEMA);
    const N = 60;
    const eids: number[] = [];
    // build entities in several txs; some retracts/updates for history
    for (let i = 0; i < N; i++) {
      const rep = await conn.transact([{ ":db/id": "x", ":p/name": pick(r, NAMES), ":p/age": randInt(r, 1, 6), ":p/flag": r() < 0.5 }]);
      eids.push(rep.tempids.x);
    }
    for (let i = 0; i < 120; i++) {
      const e = pick(r, eids);
      const kind = r();
      if (kind < 0.3) await conn.transact([[":db/add", e, ":p/friend", pick(r, eids)]]);
      else if (kind < 0.5) await conn.transact([[":db/add", e, ":p/boss", pick(r, eids)]]);
      else if (kind < 0.7) await conn.transact([[":db/add", e, ":p/tag", pick(r, TAGS)]]);
      else if (kind < 0.85) await conn.transact([[":db/add", e, ":p/age", randInt(r, 1, 6)]]);
      else if (kind < 0.95) await conn.transact([[":db/retract", e, ":p/tag"]]);
      else await conn.transact([[":db/retractEntity", e]]);
      if (i === 60) await conn.index(); // half in trees, half in novelty
    }

    const runSuite = async (label: string) => {
      const db = conn.db();
      // Facts = the whole EAVT current view (attributes as ids, like the engine binds them)
      const facts: Fact[] = [];
      for (const d of await db.datomsArray(Index.EAVT, {})) facts.push({ e: d.e, a: d.a, v: datomJsValue(d) });
      expect(facts.length).toBeGreaterThan(50);
      const vars = ["?a", "?b", "?c", "?d"];
      for (let q = 0; q < 150; q++) {
        const nPat = randInt(r, 1, 3);
        const patterns: Pattern[] = [];
        for (let p = 0; p < nPat; p++) {
          const attr = pick(r, ATTRS);
          const E: unknown = r() < 0.7 ? pick(r, vars.slice(0, 2)) : r() < 0.5 ? pick(r, eids) : "_";
          const A: unknown = r() < 0.9 ? attr : r() < 0.5 ? "?attr" : "_";
          let V: unknown;
          const roll = r();
          if (roll < 0.5) V = pick(r, vars);
          else if (roll < 0.7) V = "_";
          else {
            switch (attr) {
              case ":p/name": V = pick(r, NAMES); break;
              case ":p/age": V = randInt(r, 1, 6); break;
              case ":p/tag": V = pick(r, TAGS); break;
              case ":p/flag": V = r() < 0.5; break;
              default: V = pick(r, eids);
            }
            if (A !== attr && typeof V !== "number") V = "?v"; // avoid typed constants with unknown attribute
          }
          patterns.push([E, A, V]);
        }
        const used = new Set<string>();
        for (const p of patterns) for (const t of p) if (typeof t === "string" && t.startsWith("?")) used.add(t);
        if (used.size === 0) continue;
        const findVars = [...used].slice(0, randInt(r, 1, used.size));
        // attribute variables bind ids in the engine; convert facts to compare
        const expected = naive(
          facts,
          patterns.map((p) => [p[0], typeof p[1] === "string" && p[1].startsWith(":") ? db.attr(p[1])!.id : p[1], p[2]] as Pattern),
          findVars,
        );
        const where = patterns.map((p) => [p[0], p[1], p[2]]);
        const got = (await query(db, { find: findVars, where })) as unknown[][];
        const gotSet = new Set(got.map((row) => row.map(vkey).join("|")));
        if (gotSet.size !== expected.size || [...expected].some((k) => !gotSet.has(k))) {
          throw new Error(`[${label}] mismatch for query ${JSON.stringify({ find: findVars, where })}\n got ${[...gotSet].sort().join("\n     ")}\n want ${[...expected].sort().join("\n      ")}`);
        }
      }
    };
    await runSuite("half-indexed");
    await conn.index();
    await runSuite("fully-indexed");
    // as-of at an old basis equals naive over the old snapshot: spot check via count of names
    const old = conn.db().asOf(30);
    const n = await query(old, `[:find (count ?e) . :where [?e :p/name]]`);
    expect(n).toBeLessThan(N);
  }, 15_000);
});
