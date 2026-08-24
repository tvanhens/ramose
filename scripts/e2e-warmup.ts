/**
 * Post-deploy wait used by `scripts/e2e-cloudflare.sh`.
 *
 * `/health` is the Worker fetch handler only. Admin `/info` now fails
 * closed if the Transactor or Replica answers non-2xx, and a write is
 * what the suite does next — so we retry both through the same Bun
 * `fetch` + `Connection: close` ladder the e2e harness uses. A curl
 * `/info` 200 on one colo used to let the suite start while bun's colo
 * still served "Worker not found" on the first transact.
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
await db.info();
await db.transact([attrMap(":e2e/warmup", "string")]);
console.log(">> warmup write ok");
