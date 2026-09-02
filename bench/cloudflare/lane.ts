export type LaneTarget = "transact" | "operation" | "info" | "socket-ping" | "socket-write";

export const MAX_LANE_PARALLEL = 6;
export const MAX_LANE_REQUESTS = 5_000;
export const LANE_PATH = "/__bench__/lane";
export const SOCKET_PATH = "/__bench__/socket";
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
  readonly serverEvents: Record<string, number>;
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
  if (req.target === "info") {
    return new Request(`${origin}/__test__/db/${encodeURIComponent(req.db)}/info`, {
      method: "POST",
      headers: { "content-type": "application/json", [CAPABILITY_HEADER]: capability },
      body: "{}",
    });
  }
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

type SocketFrame = { kind: string; id?: number; message?: string };

const runSocketLane = async (
  req: LaneRequest,
  fetcher: LaneFetcher,
  origin: string,
  capability: string,
  colo: string,
  serverEvents: () => Record<string, number>,
): Promise<LaneReport> => {
  const parallel = Math.max(1, Math.min(MAX_LANE_PARALLEL, Math.floor(req.parallel)));
  const maxRequests = Math.max(1, Math.min(MAX_LANE_REQUESTS, Math.floor(req.maxRequests)));
  const startedAt = Date.now();
  const deadline = startedAt + Math.max(0, req.durationMs);
  const latencies: number[] = [];
  const failures: Record<string, number> = {};
  let ok = 0;
  let errors = 0;
  const response = await fetcher.fetch(
    new Request(`${origin}${SOCKET_PATH}?db=${encodeURIComponent(req.db)}`, {
      headers: { Upgrade: "websocket", [CAPABILITY_HEADER]: capability },
    }),
  );
  const socket = (response as Response & { webSocket?: WebSocket }).webSocket;
  if (response.status !== 101 || socket === undefined || socket === null) {
    const text = await response.text();
    failures[`socket ${response.status} ${text.slice(0, 160)}`] = 1;
    return { colo, serverEvents: serverEvents(), ok: 0, errors: 1, failures, latencies, startedAt, endedAt: Date.now() };
  }
  socket.accept();
  const pending = new Map<number, { readonly t0: number; readonly resolve: (frame: SocketFrame) => void }>();
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    let frame: SocketFrame;
    try {
      frame = JSON.parse(event.data) as SocketFrame;
    } catch {
      return;
    }
    if (typeof frame.id !== "number") return;
    const waiter = pending.get(frame.id);
    if (waiter === undefined) return;
    pending.delete(frame.id);
    waiter.resolve(frame);
  });
  let closed: string | undefined;
  socket.addEventListener("close", (event) => {
    closed = `socket closed ${event.code} ${event.reason}`;
    for (const [, waiter] of pending) waiter.resolve({ kind: "error", message: closed });
    pending.clear();
  });
  socket.addEventListener("error", () => {
    closed = "socket error";
  });
  let nextId = 0;
  let issued = 0;
  const exchange = (frame: Record<string, unknown>): Promise<{ frame: SocketFrame; ms: number }> =>
    new Promise((resolve) => {
      const id = nextId++;
      const t0 = performance.now();
      pending.set(id, { t0, resolve: (reply) => resolve({ frame: reply, ms: performance.now() - t0 }) });
      socket.send(JSON.stringify({ ...frame, id }));
    });
  const slots = Array.from({ length: parallel }, async (_, slot) => {
    let i = 0;
    while (Date.now() < deadline && issued < maxRequests && closed === undefined) {
      issued++;
      const frame = req.target === "socket-ping"
        ? { v: 1, kind: "ping" }
        : {
          v: 1,
          kind: "write",
          tx: [{ ":k/id": idOf(req.lane, slot, i), ":k/v": "x" }],
          clientTxId: `${req.run}-${req.lane}-${slot}-${i}`,
        };
      i++;
      const { frame: reply, ms } = await exchange(frame);
      latencies.push(Math.round(ms * 100) / 100);
      const failed = reply.kind === "error";
      if (!failed) ok++;
      else {
        errors++;
        const key = `frame error: ${(reply.message ?? "").slice(0, 160)}`;
        failures[key] = (failures[key] ?? 0) + 1;
      }
    }
  });
  await Promise.all(slots);
  try {
    socket.close(1000, "done");
  } catch {}
  return { colo, serverEvents: serverEvents(), ok, errors, failures, latencies, startedAt, endedAt: Date.now() };
};

export const runLane = async (
  req: LaneRequest,
  fetcher: LaneFetcher,
  origin: string,
  capability: string,
  colo: string,
  serverEvents: () => Record<string, number>,
): Promise<LaneReport> => {
  if (req.target === "socket-ping" || req.target === "socket-write") {
    return runSocketLane(req, fetcher, origin, capability, colo, serverEvents);
  }
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
  return { colo, serverEvents: serverEvents(), ok, errors, failures, latencies, startedAt, endedAt: Date.now() };
};
