import { describe, expect, test } from "bun:test";
import {
  passOutcome,
  queueUnreplayable,
  type PassOutcome,
} from "../../src/client/submission.ts";
import { invocationId } from "../../src/db/refs.ts";
import type {
  InterruptedReason,
  QueueProgress,
} from "../../src/internal/replication/submission.ts";
import {
  replicaDatabaseKey,
  type ReplicaDatabaseScope,
} from "../../src/internal/replication/replica-lifecycle.ts";

const opaque = (character: string): string => character.repeat(43);

const receiver: ReplicaDatabaseScope = {
  server: opaque("s"),
  principal: opaque("p"),
  database: opaque("d"),
};

const entry = (state: QueueProgress["state"]): QueueProgress => ({
  partition: opaque("q"),
  receiver,
  state,
});

const interrupted = (reason: InterruptedReason): QueueProgress =>
  entry({ _tag: "Interrupted", reason });

const committed = (): QueueProgress =>
  entry({ _tag: "Committed", invocation: invocationId() });

const retry = (): QueueProgress =>
  entry({ _tag: "Retry", invocation: invocationId(), reason: "unreachable" });

describe("what a submission pass does next", () => {
  test("each outcome follows from what the pass left behind", () => {
    const cases: readonly (readonly [PassOutcome, readonly QueueProgress[]])[] = [
      ["settled", []],
      ["settled", [entry({ _tag: "Empty" })]],
      ["settled", [entry({ _tag: "Offline" })]],
      ["settled", [entry({ _tag: "Blocked", missing: [] })]],
      ["settled", [entry({ _tag: "Refused", invocation: invocationId(), code: "no" })]],
      ["again", [committed()]],
      ["again", [entry({ _tag: "Rejected", invocation: invocationId(), code: "no" })]],
      ["later", [retry()]],
      ["later", [interrupted("aborted")]],
      ["later", [interrupted("storage")]],
      ["later", [interrupted("scope-unconfirmed")]],
      ["obstructed", [interrupted("invocation-conflict")]],
      ["obstructed", [interrupted("record-invalid")]],
      ["obstructed", [interrupted("mapping-refused")]],
      ["stand-down", [interrupted("leadership-fenced")]],
      ["withdraw", [interrupted("scope-fenced")]],
    ];
    for (const [outcome, progress] of cases) {
      expect([outcome, passOutcome(progress)]).toEqual([outcome, outcome]);
    }
  });

  test("a refused fence ends the pass however much else advanced", () => {
    expect(passOutcome([committed(), interrupted("leadership-fenced")]))
      .toBe("stand-down");
    expect(passOutcome([retry(), interrupted("leadership-fenced")]))
      .toBe("stand-down");
    expect(passOutcome([committed(), interrupted("scope-fenced")]))
      .toBe("withdraw");
    expect(passOutcome([interrupted("scope-fenced"), interrupted("storage")]))
      .toBe("withdraw");
  });

  test("a withdrawn scope outranks the leadership that was submitting for it", () => {
    expect(
      passOutcome([interrupted("leadership-fenced"), interrupted("scope-fenced")]),
    ).toBe("withdraw");
  });

  test("work that advanced is drained before a transient failure waits", () => {
    expect(passOutcome([committed(), retry()])).toBe("again");
    expect(passOutcome([committed(), interrupted("storage")])).toBe("again");
  });

  test("a queue this build cannot replay never asks for another attempt", () => {
    expect(passOutcome([interrupted("record-invalid"), retry()])).toBe("later");
    expect(passOutcome([interrupted("record-invalid"), committed()])).toBe("again");
    expect(passOutcome([interrupted("record-invalid"), interrupted("scope-fenced")]))
      .toBe("withdraw");
    expect(
      passOutcome([interrupted("mapping-refused"), interrupted("leadership-fenced")]),
    ).toBe("stand-down");
    expect(passOutcome([entry({ _tag: "Offline" }), interrupted("mapping-refused")]))
      .toBe("obstructed");
  });
});

describe("what a database learns from a pass over its own queue", () => {
  const key = replicaDatabaseKey(receiver);
  const elsewhere = replicaDatabaseKey({ ...receiver, database: opaque("e") });

  test("a queue this build cannot replay reports where its receiver can see it", () => {
    for (const reason of ["record-invalid", "invocation-conflict", "mapping-refused"] as const) {
      expect([reason, queueUnreplayable([interrupted(reason)], key)])
        .toEqual([reason, true]);
      expect([reason, queueUnreplayable([interrupted(reason)], elsewhere)])
        .toEqual([reason, false]);
    }
    expect(
      queueUnreplayable(
        [entry({
          _tag: "UpdateRequired",
          invocation: invocationId(),
          reason: "operation-changed",
        })],
        key,
      ),
    ).toBe(true);
  });

  test("a queue that may still advance reports nothing", () => {
    for (const reason of ["storage", "scope-unconfirmed", "aborted", "scope-fenced"] as const) {
      expect([reason, queueUnreplayable([interrupted(reason)], key)])
        .toEqual([reason, false]);
    }
    expect(queueUnreplayable([retry(), committed(), entry({ _tag: "Offline" })], key))
      .toBe(false);
  });
});
