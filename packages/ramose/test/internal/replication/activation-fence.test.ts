/**
 * The post-commit activation fence as ordinary values (#475 slice 3).
 *
 * Everything here is a pure decision: which frames may satisfy the fence, which
 * receipts one activation covers, and what the durable rows say about a receipt
 * that is still waiting. The durable half — the counter, the fence transaction,
 * and every crash cut — is proven against real IndexedDB in the browser lane.
 */

import { describe, expect, test } from "bun:test";
import { invocationId } from "../../../src/db/refs.ts";
import {
  requiresActivationFence,
  satisfiesActivationFence,
} from "../../../src/internal/replication/activation-fence.ts";
import type { ReplicationFrame } from "../../../src/internal/replication/protocol.ts";
import {
  buildReceipt,
  decodeQueueCursor,
  decodeReceipt,
  fencedByActivation,
  mutationPartitionKey,
  unobservedReceiptOf,
  type QueueCursorRecord,
  type ReceiptRecord,
} from "../../../src/internal/replication/outbox.ts";
import type { QueueProgress } from "../../../src/internal/replication/submission.ts";

const receiver = {
  server: "s".repeat(43),
  principal: "p".repeat(43),
  database: "d".repeat(43),
};
const partition = mutationPartitionKey(receiver);
const scope = "scope-key";

const receipt = (overrides: Partial<ReceiptRecord> = {}): ReceiptRecord =>
  buildReceipt({
    partition,
    invocation: invocationId(),
    scope,
    state: "committed",
    observation: "unobserved",
    activation: 3,
    output: null,
    mappings: [],
    failure: null,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  });

const cursor = (overrides: Partial<QueueCursorRecord> = {}): QueueCursorRecord => ({
  partition,
  scope,
  receiver,
  nextSequence: 1,
  sealing: null,
  activation: 0,
  updatedAt: 1_700_000_000_000,
  ...overrides,
});

/** Every frame type the wire contract defines, so the table cannot go stale. */
const FRAMES: readonly ReplicationFrame["type"][] = [
  "SnapshotStart",
  "SnapshotChunk",
  "SnapshotCommit",
  "Change",
  "ResumeReady",
  "Reset",
  "KeepAlive",
  "TerminalError",
];

describe("satisfiesActivationFence", () => {
  test("only a settled Change, ResumeReady, or SnapshotCommit fences", () => {
    const fencing = FRAMES.filter((frame) =>
      satisfiesActivationFence({ frame, settled: true })
    );
    expect(fencing).toEqual(["SnapshotCommit", "Change", "ResumeReady"]);
  });

  test("nothing fences unsettled, whatever the frame says", () => {
    // A change whose local install lost its CAS, an incomplete snapshot
    // staging, a keepalive, a terminal: the session settled none of them, so
    // none of them may clear a marker.
    for (const frame of FRAMES) {
      expect(satisfiesActivationFence({ frame, settled: false })).toBe(false);
    }
  });

  test("staging, liveness, and terminals never fence even when settled", () => {
    for (const frame of ["Reset", "SnapshotStart", "SnapshotChunk", "KeepAlive", "TerminalError"] as const) {
      expect(satisfiesActivationFence({ frame, settled: true })).toBe(false);
    }
  });
});

describe("fencedByActivation", () => {
  test("covers exactly the markers durable before that activation began", () => {
    const stamped = receipt({ activation: 3 });
    // A receipt acknowledged *during* activation 3 carries 3 and waits for 4:
    // activation 3's own output cannot prove the server's stream reached a
    // commit that happened after activation 3 opened.
    expect(fencedByActivation(stamped, 3)).toBe(false);
    expect(fencedByActivation(stamped, 4)).toBe(true);
    // Coalescing: one later activation covers every earlier stamp at once.
    expect(fencedByActivation(receipt({ activation: 0 }), 4)).toBe(true);
    expect(fencedByActivation(receipt({ activation: 1 }), 4)).toBe(true);
  });

  test("only a committed receipt whose marker is still on is covered", () => {
    expect(fencedByActivation(receipt({ observation: "observed" }), 9)).toBe(false);
    expect(
      fencedByActivation(
        receipt({ state: "queued", observation: null, activation: 0 }),
        9,
      ),
    ).toBe(false);
    expect(
      fencedByActivation(
        receipt({
          state: "rejected",
          observation: null,
          activation: 0,
          failure: { code: "operation_rejected" },
        }),
        9,
      ),
    ).toBe(false);
  });
});

describe("unobservedReceiptOf", () => {
  test("reports the invocation, its stamp, and when it committed — nothing else", () => {
    const mapped = receipt({
      activation: 2,
      updatedAt: 1_700_000_000_500,
      output: { title: "offline" },
    });
    expect(unobservedReceiptOf(mapped)).toEqual({
      invocation: mapped.invocation,
      activation: 2,
      committedAt: 1_700_000_000_500,
    });
  });

  test("a receipt with no marker is not awaiting a fence", () => {
    expect(unobservedReceiptOf(receipt({ observation: "observed" }))).toBeUndefined();
    expect(
      unobservedReceiptOf(receipt({ state: "queued", observation: null, activation: 0 })),
    ).toBeUndefined();
  });
});

describe("durable activation stamps", () => {
  test("a row written before the counter existed reads as zero", () => {
    // Exactly what such a row means: durable before any activation this build
    // began. No migration, and no queue orphaned by one.
    const { activation: _, ...legacyReceipt } = receipt({ activation: 0 });
    expect(decodeReceipt(legacyReceipt)?.activation).toBe(0);
    const { activation: __, ...legacyCursor } = cursor();
    expect(decodeQueueCursor(legacyCursor)?.activation).toBe(0);
  });

  test("an unreadable stamp is a refusal, not a zero", () => {
    for (const bad of [-1, 1.5, Number.NaN, "3", null]) {
      expect(decodeReceipt({ ...receipt(), activation: bad })).toBeUndefined();
      expect(decodeQueueCursor({ ...cursor(), activation: bad })).toBeUndefined();
    }
  });

  test("a receipt with no marker may not carry a stamp", () => {
    // A row that claimed one would be selected by a comparison that means
    // nothing for it.
    expect(
      decodeReceipt({
        ...receipt({ state: "queued", observation: null, activation: 0 }),
        activation: 4,
      }),
    ).toBeUndefined();
  });

  test("the builder survives its own decoder with a stamp", () => {
    const built = receipt({ activation: 7 });
    expect(built.activation).toBe(7);
    expect(decodeReceipt(structuredClone(built))).toEqual(built);
  });
});

describe("requiresActivationFence", () => {
  test("only a commit starts a fresh activation", () => {
    const progress = (state: QueueProgress["state"]): QueueProgress => ({
      partition,
      receiver,
      state,
    });
    const invocation = invocationId();
    expect(requiresActivationFence(progress({ _tag: "Committed", invocation }))).toBe(true);
    // A rejection needs no observation fence: nothing committed.
    expect(
      requiresActivationFence(
        progress({ _tag: "Rejected", invocation, code: "operation_rejected" }),
      ),
    ).toBe(false);
    for (
      const state of [
        { _tag: "Empty" },
        { _tag: "Offline" },
        { _tag: "Blocked", missing: [] },
        { _tag: "Interrupted" },
        { _tag: "Refused", invocation, code: undefined },
        { _tag: "Retry", invocation, reason: "unreachable" },
      ] as const
    ) {
      expect(requiresActivationFence(progress(state))).toBe(false);
    }
  });
});
