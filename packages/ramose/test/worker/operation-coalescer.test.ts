import { describe, expect, test } from "bun:test";
import type { AuthoritativeOperationInvocation } from "../../src/internal/authorization/index.ts";
import { MAX_INVOKE_BATCH, type InvokeOutcome } from "../../src/internal/transactor/transactor.ts";
import { coalesceInvocation } from "../../src/worker/operation-coalescer.ts";

const invocation = (id: number): AuthoritativeOperationInvocation =>
  ({ invocationId: `inv-${id}`, input: { id } }) as unknown as AuthoritativeOperationInvocation;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const echo = async (batch: readonly AuthoritativeOperationInvocation[]): Promise<readonly InvokeOutcome[]> =>
  batch.map((entry) => ({ status: 200, body: { invocationId: entry.invocationId } }));

describe("operation coalescer", () => {
  test("groups invocations that arrive within the window into one dispatch", async () => {
    const batches: number[] = [];
    const dispatch = (batch: readonly AuthoritativeOperationInvocation[]) => {
      batches.push(batch.length);
      return echo(batch);
    };
    const outcomes = await Promise.all(
      Array.from({ length: 5 }, (_, i) => coalesceInvocation("db-a", invocation(i), dispatch, 5)),
    );
    expect(batches).toEqual([5]);
    expect(outcomes.map((o) => (o.body as { invocationId: string }).invocationId)).toEqual(
      ["inv-0", "inv-1", "inv-2", "inv-3", "inv-4"],
    );
  });

  test("keeps separate keys in separate dispatches", async () => {
    const keys: string[] = [];
    const dispatch = (key: string) => (batch: readonly AuthoritativeOperationInvocation[]) => {
      keys.push(key);
      return echo(batch);
    };
    await Promise.all([
      coalesceInvocation("db-b", invocation(1), dispatch("db-b"), 2),
      coalesceInvocation("db-c", invocation(2), dispatch("db-c"), 2),
    ]);
    expect(keys.sort()).toEqual(["db-b", "db-c"]);
  });

  test("flushes early once a batch reaches the transactor limit", async () => {
    const batches: number[] = [];
    const dispatch = (batch: readonly AuthoritativeOperationInvocation[]) => {
      batches.push(batch.length);
      return echo(batch);
    };
    await Promise.all(
      Array.from({ length: MAX_INVOKE_BATCH + 3 }, (_, i) =>
        coalesceInvocation("db-d", invocation(i), dispatch, 50)),
    );
    expect(batches).toEqual([MAX_INVOKE_BATCH, 3]);
  });

  test("rejects every waiter when the dispatch fails or is mismatched", async () => {
    const failing = () => Promise.reject(new Error("down"));
    await expect(Promise.all([
      coalesceInvocation("db-e", invocation(1), failing, 1),
      coalesceInvocation("db-e", invocation(2), failing, 1),
    ])).rejects.toThrow("down");
    await Promise.allSettled([sleep(5)]);
    const short = async () => [{ status: 200, body: {} }];
    await expect(Promise.all([
      coalesceInvocation("db-f", invocation(1), short, 1),
      coalesceInvocation("db-f", invocation(2), short, 1),
    ])).rejects.toThrow("mismatched");
  });
});
