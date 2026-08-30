
import { describe, expect, test } from "bun:test";
import { invocationId } from "../../src/db/refs.ts";
import {
  MutationRejectedError,
  ReceiptDriver,
  type ReceiptState,
} from "../../src/client/receipt.ts";

const driver = () => new ReceiptDriver(invocationId());

const observed = (receipt: { subscribe: (f: () => void) => () => void; getSnapshot: () => ReceiptState }) => {
  const seen: ReceiptState[] = [receipt.getSnapshot()];
  receipt.subscribe(() => seen.push(receipt.getSnapshot()));
  return seen;
};

describe("a receipt", () => {
  test("starts pending and reaches queued, then committed", async () => {
    const it = driver();
    const seen = observed(it.receipt);
    expect(it.receipt.getSnapshot()).toEqual({ status: "pending" });

    it.queue();
    await it.receipt.queued;
    expect(it.receipt.getSnapshot()).toEqual({ status: "queued" });

    it.commit();
    await it.receipt.committed;
    expect(it.receipt.getSnapshot()).toEqual({ status: "committed" });
    expect(seen.map((state) => state.status)).toEqual(["pending", "queued", "committed"]);
  });

  test("commits without a separate queue report, for a receipt restored from durable state", async () => {
    const it = driver();
    it.commit();
    await it.receipt.queued;
    await it.receipt.committed;
    expect(it.receipt.getSnapshot()).toEqual({ status: "committed" });
  });

  test("carries the server's own code on a rejection, and fails only `committed`", async () => {
    const it = driver();
    it.queue();
    it.reject("operation-denied");
    await it.receipt.queued;
    await expect(it.receipt.committed).rejects.toBeInstanceOf(MutationRejectedError);
    const state = it.receipt.getSnapshot();
    expect(state.status).toBe("rejected");
    if (state.status === "rejected") expect(state.error.code).toBe("operation-denied");
  });

  test("fails both promises when it never became durable", async () => {
    const it = driver();
    const failure = new Error("this graph receiver never resolved");
    it.fail(failure);
    await expect(it.receipt.queued).rejects.toBe(failure);
    await expect(it.receipt.committed).rejects.toBe(failure);
    expect(it.receipt.getSnapshot()).toEqual({ status: "failed", error: failure });
  });

  test("cannot be unsettled, and republishes nothing for a repeated report", async () => {
    const it = driver();
    const seen = observed(it.receipt);
    it.queue();
    it.queue();
    it.commit();
    it.commit();
    it.reject("too-late");
    it.fail(new Error("also too late"));
    expect(it.receipt.getSnapshot()).toEqual({ status: "committed" });
    expect(seen.map((state) => state.status)).toEqual(["pending", "queued", "committed"]);
    await it.receipt.committed;

    const queued = driver();
    queued.queue();
    queued.fail(new Error("nothing was written"));
    expect(queued.receipt.getSnapshot()).toEqual({ status: "queued" });
  });

  test("never leaks an unhandled rejection to a caller that awaits only one promise", async () => {
    const rejected = driver();
    rejected.queue();
    rejected.reject("denied");
    await rejected.receipt.queued;
    await Promise.resolve();
    expect(rejected.receipt.getSnapshot().status).toBe("rejected");
  });
});
