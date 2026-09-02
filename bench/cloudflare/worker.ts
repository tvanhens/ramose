import * as Effect from "effect/Effect";
import { deployOperationCatalogs } from "ramose/worker";
import type { RamoseEnv } from "../../packages/ramose/src/RamoseEnv.ts";
import {
  QueryReplicaDO,
  createServer,
  createTransactorDO,
} from "../../packages/ramose/src/worker/testing.ts";
import { benchCatalogDeployment } from "./catalog.ts";
import {
  CAPABILITY_HEADER,
  LANE_PATH,
  type LaneFetcher,
  type LaneRequest,
  runLane,
} from "./lane.ts";

type BenchEnv = RamoseEnv & { BENCH_SELF: LaneFetcher };

const operationCatalogs = await Effect.runPromise(
  deployOperationCatalogs(benchCatalogDeployment),
);

const server = createServer({ operationCatalogs });

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
    if (url.pathname === LANE_PATH && request.method === "POST") {
      const capability = grantedCapability(request, env);
      if (capability === undefined) return new Response("not found", { status: 404 });
      const lane = (await request.json()) as LaneRequest;
      const colo = (request.cf as { colo?: string } | undefined)?.colo ?? "unknown";
      const report = await runLane(lane, env.BENCH_SELF, url.origin, capability, colo);
      return new Response(JSON.stringify(report), {
        headers: { "content-type": "application/json" },
      });
    }
    return server.fetch(request, env, ctx);
  },
};
export { QueryReplicaDO };
export const TransactorDO = createTransactorDO(operationCatalogs);
