import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { schemaTx } from "../packages/ramose/src/db/internal.ts";
import { DatabaseId } from "../packages/ramose/src/internal/authorization/index.ts";
import type { AuthenticatedCaller } from "../packages/ramose/src/internal/authorization/request.ts";
import {
  deployOperationCatalogsForVersion,
  deployedOperationCatalogs,
} from "../packages/ramose/src/worker/operation-catalogs.ts";
import { BENCH_DATABASE, BenchSchema, benchCatalogDeployment } from "./cloudflare/catalog.ts";
import { fmt, percentile } from "./lib.ts";
import { BenchHarness, attribute } from "./transactor-harness.ts";

const conc = Number(process.argv[2] ?? 64);
const seconds = Number(process.argv[3] ?? 5);
const mode = process.argv[4] ?? "both";

const dir = mkdtempSync(join(tmpdir(), "ramose-op-"));

const operationCatalogs = await Effect.runPromise(deployOperationCatalogsForVersion(
  benchCatalogDeployment,
  { id: "bench", tag: "bench", timestamp: "1970-01-01T00:00:00.000Z" },
));
const deployed = deployedOperationCatalogs(operationCatalogs);
const database = DatabaseId.make(BENCH_DATABASE);
const bound = Result.getOrThrow(deployed.requireDatabase(database));
const definition = bound.definition;

const caller: AuthenticatedCaller = {
  claims: { sub: "bench-writer" },
  classes: ["writer"],
  exp: Math.floor(Date.now() / 1000) + 3600,
};

const harness = (label: string) =>
  new BenchHarness({
    dbName: BENCH_DATABASE,
    file: join(dir, `${label}.sqlite`),
    config: { indexTxThreshold: 1_000_000, indexIntervalMs: 1_000_000 },
    operationRuntime: {
      catalogs: deployed,
      environment: {},
      now: () => Date.now(),
    },
  });

type Client = (id: number, i: number) => Promise<unknown>;

const drive = async (label: string, h: BenchHarness, client: Client) => {
  const tx = h.transactor;
  let done = 0, errors = 0;
  let firstError: string | undefined;
  const lat: number[] = [];
  const deadline = Date.now() + seconds * 1000;
  const run = async (id: number) => {
    let i = 0;
    while (Date.now() < deadline) {
      const t0 = performance.now();
      try {
        const result = await client(id, i++);
        if (typeof result === "object" && result !== null && "_tag" in result && (result as { _tag: string })._tag !== "Completed") {
          errors++;
          firstError ??= JSON.stringify(result).slice(0, 200);
        } else done++;
      } catch (e) {
        errors++;
        firstError ??= e instanceof Error ? e.message : String(e);
      }
      lat.push(performance.now() - t0);
    }
  };
  const t0 = performance.now();
  await Promise.all(Array.from({ length: conc }, (_, i) => run(i)));
  const ms = performance.now() - t0;
  lat.sort((a, b) => a - b);
  const rate = (done / ms) * 1000;
  console.log(`${label.padEnd(10)} concurrency=${conc}: ${done} ok in ${fmt(ms, 0)} ms → ${fmt(rate, 0)}/s, errors=${errors}${firstError === undefined ? "" : ` (${firstError})`}`);
  console.log(`  ack p50 ${fmt(percentile(lat, 50))} ms  p99 ${fmt(percentile(lat, 99))} ms  batches=${tx.stats.batches} avgBatch=${fmt(tx.stats.txs / Math.max(1, tx.stats.batches), 1)} storage writes=${h.writes} µs/item=${fmt((ms * 1000) / Math.max(1, done))}`);
  h.db.close();
  return rate;
};

const rows: Record<string, unknown>[] = [];

if (mode === "both" || mode === "transact") {
  const h = harness("transact");
  const tx = h.transactor;
  await tx.init();
  await tx.transact([attribute(":k/id", "long", { ":db/unique": ":db.unique/identity" }), attribute(":k/v", "string")]);
  const rate = await drive("transact", h, (id, i) => tx.transact([{ ":k/id": id * 1_000_000 + i, ":k/v": "x" }]));
  rows.push({ phase: "transact", "per second": Math.round(rate) });
}

if (mode === "both" || mode === "operation") {
  const h = harness("operation");
  const tx = h.transactor;
  await tx.init();
  await tx.transact(schemaTx(BenchSchema));
  await tx.provisionCatalog(definition);
  const run = Date.now().toString(36);
  const rate = await drive("operation", h, (id, i) =>
    tx.invoke({
      database,
      catalogKey: definition.catalogKey,
      unitHash: definition.unitHash,
      owner: { kind: "entity", name: "benchItem" },
      localName: "create",
      input: { key: `${run}-${id}-${i}`, value: "x" },
      caller,
      invocationId: crypto.randomUUID(),
    }));
  rows.push({ phase: "operation", "per second": Math.round(rate) });
}

rmSync(dir, { recursive: true, force: true });
console.table(rows);
