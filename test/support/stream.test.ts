import { expect, test } from "bun:test";
import { readLiveNdjson } from "./live-query.ts";
import { readReplicationNdjson } from "./replication.ts";
import { closeObservedStream, withRequestDeadline } from "./stream.ts";

test("a request that never answers fails at its deadline, naming itself", async () => {
  const started = Date.now();

  const failure = await withRequestDeadline(
    () => new Promise<Response>(() => {}),
    "POST /db/graph-path-root/op",
    250,
  ).then(() => undefined, (error: Error) => error);

  expect(failure?.message).toBe(
    "POST /db/graph-path-root/op did not answer within 250ms",
  );
  expect(Date.now() - started).toBeLessThan(5_000);
});

test("the deadline aborts the exchange so the socket is released", async () => {
  let observed: AbortSignal | undefined;
  await withRequestDeadline(
    (signal) => {
      observed = signal;
      return new Promise<Response>(() => {});
    },
    "GET /health",
    50,
  ).catch(() => undefined);
  expect(observed?.aborted).toBe(true);
});

test("an exchange that honours the signal still reports the deadline", async () => {

  const failure = await withRequestDeadline(
    (signal) =>
      new Promise<Response>((_, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    "POST /db/x/op",
    50,
  ).then(() => undefined, (error: Error) => error);
  expect(failure?.message).toBe("POST /db/x/op did not answer within 50ms");
});

test("a deadline that does not expire returns the answer untouched", async () => {
  const response = new Response("ok");
  expect(
    await withRequestDeadline(async () => response, "GET /health", 5_000),
  ).toBe(response);
});

test("a real failure is reported as itself, not as a deadline", async () => {
  const failure = await withRequestDeadline(
    () => Promise.reject(new Error("ECONNREFUSED")),
    "GET /health",
    5_000,
  ).then(() => undefined, (error: Error) => error);
  expect(failure?.message).toBe("ECONNREFUSED");
});

const stalled = (): Response =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{}\n"));
      },
    }),
    { headers: { "content-type": "application/x-ndjson" } },
  );

test("closing a stalled replication stream settles its own pending read", async () => {
  const iterator = readReplicationNdjson(stalled())[Symbol.asyncIterator]();

  const parked = iterator.next().catch(() => undefined);

  const started = Date.now();
  await closeObservedStream(iterator);
  expect(Date.now() - started).toBeLessThan(1_000);
  await parked;
});

test("closing a stalled live-query stream settles its own pending read", async () => {
  const iterator = readLiveNdjson(stalled())[Symbol.asyncIterator]();
  const first = await iterator.next();
  expect(first.done).toBe(false);
  const parked = iterator.next().catch(() => undefined);

  const started = Date.now();
  await closeObservedStream(iterator);
  expect(Date.now() - started).toBeLessThan(1_000);
  await parked;
});

test("a transport cancel that stalls is abandoned at the same deadline", async () => {

  const started = Date.now();
  await closeObservedStream(
    {
      cancelTransport: () => new Promise<never>(() => {}),
      return: () => Promise.resolve({ done: true, value: undefined }),
    },
    250,
  );
  const elapsed = Date.now() - started;
  expect(elapsed).toBeGreaterThanOrEqual(200);
  expect(elapsed).toBeLessThan(5_000);
});

test("a close that cannot settle is abandoned at its deadline, not awaited", async () => {

  const started = Date.now();
  await closeObservedStream(
    { return: () => new Promise<never>(() => {}) },
    250,
  );
  const elapsed = Date.now() - started;
  expect(elapsed).toBeGreaterThanOrEqual(200);
  expect(elapsed).toBeLessThan(5_000);
});

test("a close whose return rejects does not surface as an unhandled rejection", async () => {
  await closeObservedStream({
    return: () => Promise.reject(new Error("already released")),
  });

  await Bun.sleep(10);
});
