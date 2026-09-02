import * as Effect from "effect/Effect";
import { deployOperationCatalogs } from "ramose/worker";
import { setTelemetrySink, type TelemetryEvent } from "../../packages/ramose/src/internal/core/telemetry.ts";
import type { RamoseEnv } from "../../packages/ramose/src/RamoseEnv.ts";
import {
  QueryReplicaDO,
  createServer,
  createTransactorDO,
} from "../../packages/ramose/src/worker/testing.ts";
import { benchCatalogDeployment } from "./catalog.ts";
import { internalHeaders } from "../../packages/ramose/src/internal/transactor/internal.ts";
import {
  CAPABILITY_HEADER,
  LANE_PATH,
  SOCKET_PATH,
  type LaneFetcher,
  type LaneRequest,
  runLane,
} from "./lane.ts";

type BenchEnv = RamoseEnv & { BENCH_SELF: LaneFetcher };

const operationCatalogs = await Effect.runPromise(
  deployOperationCatalogs(benchCatalogDeployment),
);

const server = createServer({ operationCatalogs });

const SERVER_EVENT_LIMIT = 200;
const serverEvents = new Map<string, number>();
setTelemetrySink((e: TelemetryEvent) => {
  console.log(JSON.stringify(e));
  if (e.level !== "warn" && e.level !== "error") return;
  const detail = typeof e.error === "string" ? e.error : typeof e.code === "string" ? e.code : "";
  const key = `${e.component}.${e.event}${detail === "" ? "" : `: ${detail.slice(0, 160)}`}`;
  if (serverEvents.size >= SERVER_EVENT_LIMIT && !serverEvents.has(key)) return;
  serverEvents.set(key, (serverEvents.get(key) ?? 0) + 1);
});
const drainServerEvents = (): Record<string, number> => {
  const out = Object.fromEntries(serverEvents);
  serverEvents.clear();
  return out;
};

const sameSecret = (left: string, right: string): boolean => {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
};

const grantedCapability = (request: Request, env: BenchEnv): string | undefined => {
  const capability = env.RAMOSE_TEST_CAPABILITY;
  if (env.RAMOSE_TEST_HOOKS !== "1" || capability === undefined || capability.length < 32) {
    return undefined;
  }
  const supplied = request.headers.get(CAPABILITY_HEADER) ?? "";
  return sameSecret(supplied, capability) ? capability : undefined;
};

export default {
  async fetch(request: Request, env: BenchEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === SOCKET_PATH) {
      const capability = grantedCapability(request, env);
      if (capability === undefined) return new Response("not found", { status: 404 });
      const db = url.searchParams.get("db") ?? "";
      const stub = env.TRANSACTOR.get(env.TRANSACTOR.idFromName(db));
      return stub.fetch(`https://transactor/subscribe?writer=1&db=${encodeURIComponent(db)}`, {
        headers: { Upgrade: "websocket", ...internalHeaders(env) },
      });
    }
    if (url.pathname === LANE_PATH && request.method === "POST") {
      const capability = grantedCapability(request, env);
      if (capability === undefined) return new Response("not found", { status: 404 });
      const lane = (await request.json()) as LaneRequest;
      const colo = (request.cf as { colo?: string } | undefined)?.colo ?? "unknown";
      const report = await runLane(lane, env.BENCH_SELF, url.origin, capability, colo, drainServerEvents);
      return new Response(JSON.stringify(report), {
        headers: { "content-type": "application/json" },
      });
    }
    return server.fetch(request, env, ctx);
  },
};
export { QueryReplicaDO };
export const TransactorDO = createTransactorDO(operationCatalogs);
