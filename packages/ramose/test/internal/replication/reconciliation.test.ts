import { describe, expect, test } from "bun:test";
import type { ProjectionChangeset } from "../../../src/db/Projection.ts";
import { clientRef, invocationId, unsafeEntityId } from "../../../src/db/refs.ts";
import * as Data from "effect/Data";
import { pendingLayerState } from "../../../src/internal/replication/reconciliation.ts";
import { interruptedReason } from "../../../src/internal/replication/submission.ts";
import { replicaLeaderKey } from "../../../src/internal/replication/leadership.ts";
import {
  replicaDatabaseKey,
  replicaScopeKey,
} from "../../../src/internal/replication/replica-lifecycle.ts";
import type {
  OverlayLayer,
  OverlayLayers,
} from "../../../src/internal/replication/overlay-layers.ts";

const handle = unsafeEntityId("A".repeat(54) + "B");
const alpha = clientRef();
const beta = clientRef();

let sequence = 0;
const layer = (
  changeset: ProjectionChangeset,
  overrides: Partial<OverlayLayer> = {},
): OverlayLayer => ({
  invocation: invocationId(),
  sequence: ++sequence,
  state: "queued",
  settled: 0,
  activation: null,
  declared: [alpha, beta],
  changeset,
  ...overrides,
});

const setTitle = (entity: string, value: string): ProjectionChangeset => [{
  op: "set",
  entity: entity as never,
  field: ":issue/title",
  value: { type: "string", value },
}];

describe("the .local pending sidecar", () => {
  test("names every entity the layers touch, and the invocations holding it", () => {
    const first = layer(setTitle(alpha, "one"));
    const second = layer(setTitle(alpha, "two"));
    const third = layer(setTitle(handle, "other"));
    const pending = pendingLayerState([first, second, third]);
    expect([...pending.keys()].sort()).toEqual([alpha, handle].sort());
    expect(pending.get(alpha)?.invocations)
      .toEqual([first.invocation, second.invocation]);
    expect(pending.get(handle)?.invocations).toEqual([third.invocation]);
  });

  test("stays queued while any layer touching the entity is still queued", () => {
    const committed = layer(setTitle(alpha, "one"), {
      state: "committed-unobserved",
      activation: 2,
    });
    expect(pendingLayerState([committed]).get(alpha)?.state)
      .toBe("committed-unobserved");
    expect(
      pendingLayerState([committed, layer(setTitle(alpha, "two"))]).get(alpha)?.state,
    ).toBe("queued");
  });

  test("reports the ref a layer brought into the view as created", () => {
    const created = layer([
      { op: "create", entity: alpha, slot: "draft", type: "Issue" },
    ]);
    expect(pendingLayerState([created]).get(alpha)).toMatchObject({
      ref: alpha,
      created: true,
      state: "queued",
    });
    expect(pendingLayerState([layer(setTitle(alpha, "x"))]).get(alpha)?.created)
      .toBe(false);
  });

  test("counts a ref-valued target as pending too", () => {
    const linked = layer([{
      op: "set",
      entity: alpha,
      field: ":issue/owner",
      value: { type: "ref", value: beta },
    }]);
    expect([...pendingLayerState([linked]).keys()].sort())
      .toEqual([alpha, beta].sort());
  });

  test("is recomputed, so removing a layer removes its contribution", () => {
    const kept = layer(setTitle(alpha, "kept"));
    const removed = layer(setTitle(beta, "gone"));
    const before: OverlayLayers = [kept, removed];
    expect([...pendingLayerState(before).keys()].sort())
      .toEqual([alpha, beta].sort());
    expect([...pendingLayerState([kept]).keys()]).toEqual([alpha]);
  });

  test("no layers means no pending state at all", () => {
    expect(pendingLayerState([]).size).toBe(0);
  });
});

class Fenced extends Data.TaggedError("ReplicaFencedError")<{
  readonly key: string;
}> {}
class Conflict extends Data.TaggedError("OutboxInvocationConflict")<{
  readonly partition: string;
}> {}
class Invalid extends Data.TaggedError("OutboxRecordInvalid")<{
  readonly reason: string;
}> {}

describe("the interruption taxonomy", () => {
  test("names the durable conditions a retry cannot clear", () => {
    expect(interruptedReason(new Fenced({ key: "scope" }))).toBe("scope-fenced");
    expect(interruptedReason(new Conflict({ partition: "p" })))
      .toBe("invocation-conflict");
    expect(interruptedReason(new Invalid({ reason: "unreadable" })))
      .toBe("record-invalid");
  });

  test("a leadership epoch is told apart from the scope it was submitting for", () => {
    const scope = replicaScopeKey({ server: "s", principal: "p" });
    const database = replicaDatabaseKey({ server: "s", principal: "p", database: "d" });
    expect(interruptedReason(new Fenced({ key: scope }))).toBe("scope-fenced");
    expect(interruptedReason(new Fenced({ key: database }))).toBe("scope-fenced");
    expect(
      interruptedReason(new Fenced({
        key: replicaLeaderKey(
          { server: "s", principal: "p", database: "d" },
          "ramose-replicas",
        ),
      })),
    ).toBe("leadership-fenced");
  });

  test("an aborted pass is itself, and anything unfamiliar is still reported", () => {
    const aborted = new Error("aborted");
    aborted.name = "AbortError";
    expect(interruptedReason(aborted)).toBe("aborted");
    expect(interruptedReason(new Error("disk"))).toBe("storage");
    expect(interruptedReason(undefined)).toBe("storage");
    expect(interruptedReason("a string")).toBe("storage");
  });
});
