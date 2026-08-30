const url = process.env.RAMOSE_URL;
if (url === undefined || url === "") {
  console.error("error: RAMOSE_URL is not set");
  process.exit(1);
}

const base = url.replace(/\/+$/, "");
const attempts = 30;
const delayMs = 2_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let last = "no attempt";
for (let i = 0; i < attempts; i++) {
  try {
    const health = await fetch(`${base}/health`);
    if (!health.ok) {
      last = `warmup /health ${health.status}`;
    } else {
      const closed = await fetch(`${base}/db/e2e-warmup/info`);
      if (closed.status === 401) {
        console.log(">> warmup fail-closed 401 ok");
        process.exit(0);
      }
      last = `warmup expected /db/*/info 401, got ${closed.status}`;
    }
  } catch (error) {
    last = error instanceof Error ? error.message : String(error);
  }
  await sleep(delayMs);
}

throw new Error(`${last} after ${attempts} attempts`);
