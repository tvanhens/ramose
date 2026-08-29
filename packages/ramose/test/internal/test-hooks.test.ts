/**
 * Checkpoint registry is pure isolate state. Arming, waiting, throwing, and
 * the prod-stage gate do not need a Worker.
 */
import { describe, expect, test } from "bun:test";
import {
  armCheckpoint,
  checkpoint,
  checkpointStatus,
  checkpointSync,
  MAX_CHECKPOINT_RELEASE_DELAY_MS,
  releaseCheckpoint,
  resetTestHooks,
  testHooksArmed,
  testHooksEnabled,
} from "../../src/internal/test-hooks.ts";

describe("test hooks", () => {
  test("disabled on prod even when the flag is set", () => {
    expect(testHooksEnabled({ RAMOSE_TEST_HOOKS: "1", RAMOSE_STAGE: "prod" })).toBe(false);
    expect(testHooksEnabled({ RAMOSE_TEST_HOOKS: "1", RAMOSE_STAGE: "local" })).toBe(true);
    expect(testHooksEnabled({ RAMOSE_TEST_HOOKS: "1" })).toBe(true);
    expect(testHooksEnabled({})).toBe(false);
  });

  test("checkpoint is a no-op until armed", async () => {
    resetTestHooks();
    await checkpoint("transactor.commit");
    checkpointSync("transactor.commit.write");
    expect(testHooksArmed()).toBe(false);
  });

  test("arm-throw fails the real boundary", async () => {
    resetTestHooks();
    armCheckpoint("transactor.commit", "throw", "induced");
    expect(testHooksArmed()).toBe(true);
    await expect(checkpoint("transactor.commit")).rejects.toThrow("induced");
    // one-shot
    await checkpoint("transactor.commit");
  });

  test("checkpointSync throws only when armed as throw", () => {
    resetTestHooks();
    armCheckpoint("transactor.commit.write", "throw", "sync-fail");
    expect(() => checkpointSync("transactor.commit.write")).toThrow("sync-fail");
    checkpointSync("transactor.commit.write");
  });

  test("arm-wait parks until release", async () => {
    resetTestHooks();
    armCheckpoint("replica.apply", "wait");
    expect(checkpointStatus()["replica.apply"]).toEqual({ action: "wait", pending: false });
    let released = false;
    const parked = checkpoint("replica.apply").then(() => {
      released = true;
    });
    await Bun.sleep(5);
    expect(released).toBe(false);
    expect(checkpointStatus()["replica.apply"]?.pending).toBe(true);
    releaseCheckpoint("replica.apply");
    await parked;
    expect(released).toBe(true);
    expect(checkpointStatus()["replica.apply"]).toBeUndefined();
  });

  test("an armed wait can release itself in the isolate that reaches it", async () => {
    resetTestHooks();
    armCheckpoint("operation.response", "wait", undefined, 5);
    await checkpoint("operation.response");
    expect(checkpointStatus()["operation.response"]).toBeUndefined();
  });

  test("automatic checkpoint release delays are bounded", () => {
    resetTestHooks();
    expect(() =>
      armCheckpoint(
        "operation.response",
        "wait",
        undefined,
        MAX_CHECKPOINT_RELEASE_DELAY_MS + 1,
      )
    ).toThrow(/between 0 and/);
  });
});
