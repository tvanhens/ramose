/**
 * Post-deploy wait used by `scripts/e2e-cloudflare.sh`.
 *
 * `/health` is the Worker fetch handler. External `/db/*` is fail-closed
 * until authorized snapshots land — a 401 on that surface means the Worker
 * is serving the data-plane close, not that Durable Objects are ready.
 */
const url = process.env.RAMOSE_URL;
if (url === undefined || url === "") {
  console.error("error: RAMOSE_URL is not set");
  process.exit(1);
}

const base = url.replace(/\/+$/, "");

const health = await fetch(`${base}/health`);
if (!health.ok) {
  throw new Error(`warmup /health ${health.status}`);
}

const closed = await fetch(`${base}/db/e2e-warmup/info`);
if (closed.status !== 401) {
  throw new Error(`warmup expected /db/*/info 401, got ${closed.status}`);
}

console.log(">> warmup fail-closed 401 ok");
