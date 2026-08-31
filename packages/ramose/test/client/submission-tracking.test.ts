import { describe, expect, test } from "bun:test";
import { ReceiptDriver } from "../../src/client/receipt.ts";
import { SubmissionLoop } from "../../src/client/submission.ts";
import { invocationId } from "../../src/db/refs.ts";
import type { IndexedDbReplicaStorage } from "../../src/internal/replication/indexeddb.ts";
import type { ReplicaDatabaseScope } from "../../src/internal/replication/replica-lifecycle.ts";

const opaque = (character: string): string => character.repeat(43);

const receiver: ReplicaDatabaseScope = {
  server: opaque("s"),
  principal: opaque("p"),
  database: opaque("d"),
};

const NO_DURABLE_READ = "this pass reads no durable receipt";

const loopOver = (): SubmissionLoop =>
  new SubmissionLoop({
    storage: (): Promise<IndexedDbReplicaStorage> =>
      Promise.reject(new Error(NO_DURABLE_READ)),
    leadership: () => undefined,
    credential: () => Promise.reject(new Error("this pass presents no credential")),
    endpoint: () => undefined,
    resolve: () => undefined,
    retire: () => undefined,
    revalidate: () => Promise.resolve(),
    reconcile: () => Promise.resolve(),
    live: () => true,
  });

describe("what the submission loop keeps a receipt driver for", () => {
  test("a tracked driver is settled from what the queue durably holds", async () => {
    const loop = loopOver();
    loop.track(receiver, new ReceiptDriver(invocationId()));
    await expect(loop.settleFromDurable()).rejects.toThrow(NO_DURABLE_READ);
    loop.close();
  });

  test("an untracked driver leaves nothing behind to settle", async () => {
    const loop = loopOver();
    const driver = new ReceiptDriver(invocationId());
    loop.track(receiver, driver);
    loop.untrack(driver.receipt.invocation);
    await loop.settleFromDurable();
    expect(driver.receipt.getSnapshot().status).toBe("pending");
    loop.close();
  });
});
