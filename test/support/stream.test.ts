import { expect, test } from "bun:test";
import { readLiveNdjson } from "./live-query.ts";
import { readReplicationNdjson } from "./replication.ts";
import { closeObservedStream, withRequestDeadline } from "./stream.ts";

test("a request that never answers fails at its deadline, naming itself", async () => {
  const started = Date.now();
  // The shape `test/local/fixtures.ts` guards: an exchange whose promise never
  // settles, exactly as a `/op` parked behind a mid-read stream presented.
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
  // Bun's `fetch` rejects with its own `AbortError` when it does honour the
  // signal; the caller must still learn which request ran out of time.
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

/** A real body that opens and then never produces another byte. */
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
  // Park a read the way an abandoned assertion does. Nothing will ever
  // satisfy it, so a plain `return()` would queue behind it forever.
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
  // The bound has to cover the cancel too: a wedged transport can stall it,
  // and a bound that only covers `return()` is no bound.
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
  // No `cancelTransport`, and a `return()` that never resolves: the shape a
  // reader outside these helpers can still present. Cleanup must give up
  // rather than spend the caller's whole test budget.
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
  // A rejection escaping cleanup would fail whichever unrelated test the
  // runner happened to be on when it surfaced.
  await Bun.sleep(10);
});
