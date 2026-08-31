import { describe, expect, test } from "bun:test";
import { passOutcome, type PassOutcome } from "../../src/client/submission.ts";
import { invocationId } from "../../src/db/refs.ts";
import type {
  InterruptedReason,
  QueueProgress,
} from "../../src/internal/replication/submission.ts";
import type { ReplicaDatabaseScope } from "../../src/internal/replication/replica-lifecycle.ts";

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
      ["later", [interrupted("invocation-conflict")]],
      ["stand-down", [interrupted("scope-fenced")]],
    ];
    for (const [outcome, progress] of cases) {
      expect([outcome, passOutcome(progress)]).toEqual([outcome, outcome]);
    }
  });

  test("a refused fence stands the pass down however much else advanced", () => {
    expect(passOutcome([committed(), interrupted("scope-fenced")]))
      .toBe("stand-down");
    expect(passOutcome([retry(), interrupted("scope-fenced")])).toBe("stand-down");
    expect(passOutcome([interrupted("scope-fenced"), interrupted("storage")]))
      .toBe("stand-down");
  });

  test("work that advanced is drained before a transient failure waits", () => {
    expect(passOutcome([committed(), retry()])).toBe("again");
    expect(passOutcome([committed(), interrupted("storage")])).toBe("again");
  });
});
