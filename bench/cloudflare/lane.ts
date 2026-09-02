export type LaneTarget = "transact" | "operation";

export const MAX_LANE_PARALLEL = 6;
export const MAX_LANE_REQUESTS = 5_000;
export const LANE_PATH = "/__bench__/lane";
export const CAPABILITY_HEADER = "x-ramose-test-capability";

export interface LaneRequest {
  readonly target: LaneTarget;
  readonly db: string;
  readonly run: string;
  readonly lane: number;
  readonly parallel: number;
  readonly maxRequests: number;
  readonly durationMs: number;
  readonly token?: string;
}

export interface LaneReport {
  readonly colo: string;
  readonly ok: number;
  readonly errors: number;
  readonly failures: Record<string, number>;
  readonly latencies: number[];
  readonly startedAt: number;
  readonly endedAt: number;
}

export interface LaneFetcher {
  fetch(request: Request): Promise<Response>;
}

const idOf = (lane: number, slot: number, i: number): number =>
  lane * 1_000_000 + slot * 100_000 + i;

const buildRequest = (
  req: LaneRequest,
  origin: string,
  capability: string,
  slot: number,
  i: number,
): Request => {
  const id = idOf(req.lane, slot, i);
  const key = `${req.run}-${req.lane}-${slot}-${i}`;
  if (req.target === "transact") {
    return new Request(`${origin}/__test__/db/${encodeURIComponent(req.db)}/transact`, {
      method: "POST",
      headers: { "content-type": "application/json", [CAPABILITY_HEADER]: capability },
      body: JSON.stringify({ tx: [{ ":k/id": id, ":k/v": "x" }], clientTxId: key }),
    });
  }
  return new Request(`${origin}/db/${encodeURIComponent(req.db)}/op`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(req.token === undefined ? {} : { authorization: `Bearer ${req.token}` }),
    },
    body: JSON.stringify({
      invocationId: crypto.randomUUID(),
      operation: { owner: { kind: "entity", name: "benchItem" }, localName: "create" },
      input: { key, value: "x" },
    }),
  });
};

export const runLane = async (
  req: LaneRequest,
  fetcher: LaneFetcher,
  origin: string,
  capability: string,
  colo: string,
): Promise<LaneReport> => {
  const parallel = Math.max(1, Math.min(MAX_LANE_PARALLEL, Math.floor(req.parallel)));
  const maxRequests = Math.max(1, Math.min(MAX_LANE_REQUESTS, Math.floor(req.maxRequests)));
  const startedAt = Date.now();
  const deadline = startedAt + Math.max(0, req.durationMs);
  const latencies: number[] = [];
  const failures: Record<string, number> = {};
  let ok = 0;
  let errors = 0;
  let issued = 0;
  const slots = Array.from({ length: parallel }, async (_, slot) => {
    let i = 0;
    while (Date.now() < deadline && issued < maxRequests) {
      issued++;
      const t0 = performance.now();
      let error: string | undefined;
      try {
        const res = await fetcher.fetch(buildRequest(req, origin, capability, slot, i++));
        const text = await res.text();
        if (res.status !== 200) error = `${res.status} ${text.slice(0, 160)}`;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      latencies.push(Math.round((performance.now() - t0) * 100) / 100);
      if (error === undefined) ok++;
      else {
        errors++;
        failures[error] = (failures[error] ?? 0) + 1;
      }
    }
  });
  await Promise.all(slots);
  return { colo, ok, errors, failures, latencies, startedAt, endedAt: Date.now() };
};
