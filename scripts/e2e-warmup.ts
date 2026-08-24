/**
 * Post-deploy wait used by `scripts/e2e-cloudflare.sh`.
 *
 * `/health` is the Worker fetch handler only. A write creates the
 * genesis root; admin `/info` then fails closed if either DO is down.
 * Both go through the same Bun `fetch` + `Connection: close` ladder
 * the e2e harness uses. A curl `/info` 200 on one colo used to let
 * the suite start while bun's colo still served "Worker not found"
 * on the first transact.
 */
import { attrMap, Peer } from "../test/support/ramoseHttp.ts";

const url = process.env.RAMOSE_URL;
if (url === undefined || url === "") {
  console.error("error: RAMOSE_URL is not set");
  process.exit(1);
}

const client = new Peer(url, { retryTransientMs: 90_000 });
const db = client.db("e2e-warmup");

await client.health();
// A write creates the genesis root. `/info` fetches a replica basis and
// 503s "no root yet" on a brand-new name — do the write first.
await db.transact([attrMap(":e2e/warmup", "string")]);
await db.info();
console.log(">> warmup write ok");
