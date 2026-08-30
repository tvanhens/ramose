import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type { OperationVersion } from "../../../src/internal/authorization/identities.ts";
import { parseGraphPath } from "../../../src/worker/authorized-read.ts";
import { parseOperationRequest } from "../../../src/worker/authorized-operation.ts";
import {
  clientRef,
  invocationId,
  type ClientRef,
  type EntityId,
} from "../../../src/db/refs.ts";
import {
  buildOutboxRecord,
  mappingKey,
  type OutboxDraft,
  type OutboxRecord,
} from "../../../src/internal/replication/outbox.ts";
import type { ReplicaDatabaseScope } from "../../../src/internal/replication/replica-lifecycle.ts";
import {
  buildMutationRequest,
  classifyMutationResponse,
  substituteMutationRefs,
  type MutationEndpoint,
} from "../../../src/internal/replication/submission.ts";

const opaque = (character: string): string => character.repeat(43);

const receiver: ReplicaDatabaseScope = Object.freeze({
  server: opaque("s"),
  principal: opaque("p"),
  database: opaque("d"),
});

const version = "b".repeat(64) as OperationVersion;

const handle = (character: string): EntityId =>
  `${character.repeat(54)}A` as EntityId;

const record = (overrides: Partial<OutboxDraft> = {}): OutboxRecord => {
  const draft: OutboxDraft = {
    invocation: invocationId(),
    receiver,
    operation: {
      catalog: "movies" as never,
      owner: { kind: "entity", name: "issue" },
      localName: "create",
    },
    operationVersion: version,
    target: { type: "none" },
    input: { title: "offline" },
    allocations: [],
    inputRefs: [],
    enqueuedAt: 1_700_000_000_000,
    ...overrides,
  };
  return buildOutboxRecord(draft, "scope", 1);
};

const endpoint: MutationEndpoint = Object.freeze({
  origin: "https://peer.example",
  database: "movies",
  graphPath: [],
  credential: "token",
});

const handles = (
  partition: string,
  entries: readonly (readonly [ClientRef, EntityId])[],
): ReadonlyMap<string, EntityId> =>
  new Map(entries.map(([ref, id]) => [mappingKey(partition, ref), id] as const));

describe("substituteMutationRefs", () => {
  test("submits the sealed handle a client ref maps to without rewriting history", () => {
    const ref = clientRef();
    const queued = record({
      target: { type: "client-ref", clientRef: ref },
      input: { assignee: ref, title: "offline" },
      inputRefs: [{ path: ["assignee"], ref }],
    });
    const mapped = handle("A");
    const substituted = substituteMutationRefs(
      queued,
      handles(queued.partition, [[ref, mapped]]),
    );
    expect(substituted).toEqual({
      target: mapped,
      input: { assignee: mapped, title: "offline" },
    });

    expect(queued.input).toEqual({ assignee: ref, title: "offline" });
    expect(queued.target).toEqual({ type: "client-ref", clientRef: ref });
  });

  test("substitutes at a nested declared position and leaves the rest exact", () => {
    const ref = clientRef();
    const queued = record({
      input: { rows: [{ id: ref }, { id: "keep" }], count: 2 },
      inputRefs: [{ path: ["rows", 0, "id"], ref }],
    });
    const mapped = handle("B");
    expect(
      substituteMutationRefs(queued, handles(queued.partition, [[ref, mapped]])),
    ).toEqual({
      target: undefined,
      input: { rows: [{ id: mapped }, { id: "keep" }], count: 2 },
    });
  });

  test("an unmapped dependency never submits", () => {
    const ref = clientRef();
    const queued = record({
      target: { type: "client-ref", clientRef: ref },
    });
    expect(substituteMutationRefs(queued, new Map())).toBeUndefined();

    expect(
      substituteMutationRefs(
        queued,
        new Map([[mappingKey("elsewhere", ref), handle("C")]]),
      ),
    ).toBeUndefined();
  });

  test("a sealed target is submitted exactly as the durable row holds it", () => {
    const sealed = handle("D");
    const queued = record({ target: { type: "entity", entityId: sealed } });
    expect(substituteMutationRefs(queued, new Map())).toEqual({
      target: sealed,
      input: { title: "offline" },
    });
  });
});

describe("buildMutationRequest", () => {
  test("pins the operation version and carries the allocation binding", () => {
    const ref = clientRef();
    const queued = record({ allocations: [{ slot: "item", clientRef: ref }] });
    const request = buildMutationRequest(
      queued,
      endpoint,
      substituteMutationRefs(queued, new Map())!,
    );
    expect(request.body).toEqual({
      invocationId: queued.invocation,
      operationVersion: version,
      operation: { owner: { kind: "entity", name: "issue" }, localName: "create" },
      allocations: [{ slot: "item", clientRef: ref }],
      input: { title: "offline" },
    });
    expect(JSON.stringify(request.body)).not.toMatch(/run|source|bytecode/);
    expect(Object.hasOwn(request.body, "catalog")).toBe(false);
    expect(Object.hasOwn(request.body, "unitHash")).toBe(false);
  });

  test("every field of the body survives the worker's own parser", async () => {
    const ref = clientRef();
    const target = handle("T");
    const queued = record({
      target: { type: "entity", entityId: target },
      input: { title: "offline", assignee: ref },
      allocations: [{ slot: "item", clientRef: ref }],
    });
    const request = buildMutationRequest(
      queued,
      { ...endpoint, graphPath: ["org", "team"] },
      substituteMutationRefs(queued, new Map())!,
    );
    const parsed = await Effect.runPromise(parseOperationRequest(
      new Request(`${endpoint.origin}/db/${endpoint.database}/op`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request.body),
      }),
    ));

    expect(parsed.path).toEqual(["org", "team"]);
    expect(parsed.owner).toEqual({ kind: "entity", name: "issue" });
    expect(parsed.localName).toBe("create");
    expect(parsed.invocationId).toBe(queued.invocation);
    expect(parsed.operationVersion).toBe(version);
    expect(parsed.sealedTarget).toBe(target);
    expect(parsed.target).toBeUndefined();
    expect(parsed.allocations).toEqual([{ slot: "item", clientRef: ref }]);
    expect(parsed.input).toEqual({ title: "offline", assignee: ref });
  });

  test("a nested receiver's path is the one the server actually parses", () => {
    const queued = record();
    const substituted = substituteMutationRefs(queued, new Map())!;
    const root = buildMutationRequest(queued, endpoint, substituted).body;
    const nested = buildMutationRequest(
      queued,
      { ...endpoint, graphPath: ["org", "team"] },
      substituted,
    ).body;

    const search = new URLSearchParams();
    expect(Result.getOrThrow(parseGraphPath(root, search))).toEqual([]);
    expect(Result.getOrThrow(parseGraphPath(nested, search)))
      .toEqual(["org", "team"]);
  });
});

describe("classifyMutationResponse", () => {
  const ref = clientRef();
  const bound = record({ allocations: [{ slot: "item", clientRef: ref }] });
  const plain = record();
  const response = (status: number, body: unknown) =>
    ({ _tag: "Response", status, body }) as const;

  const completedReceipt = (invocation: string) =>
    ({ version: 2, invocationId: invocation, status: "completed" }) as const;

  test("a completed answer commits with the exact mappings", () => {
    const mapped = handle("E");
    expect(classifyMutationResponse(
      bound,
      response(200, {
        result: { id: 7 },
        receipt: completedReceipt(bound.invocation),
        mappings: [{ clientRef: ref, entityId: mapped }],
      }),
    )).toEqual({
      _tag: "Committed",
      output: { id: 7 },
      mappings: [{ clientRef: ref, entityId: mapped }],
    });
  });

  test("a 200 without the durable completed receipt is not a commit", () => {
    const mappings = [{ clientRef: ref, entityId: handle("E") }];
    for (const receipt of [
      undefined,
      { version: 2, invocationId: bound.invocation, status: "rejected" },
      { version: 1, invocationId: bound.invocation, status: "completed" },
      completedReceipt("iv1_00000000-0000-7000-8000-000000000000"),
    ]) {
      expect(classifyMutationResponse(
        bound,
        response(200, { result: { id: 7 }, receipt, mappings }),
      )).toEqual({ _tag: "Retry", reason: "malformed" });
    }
  });

  test("a commit that does not map every declared slot is never a commit", () => {
    for (const mappings of [
      undefined,
      [],
      [{ clientRef: clientRef(), entityId: handle("F") }],
      [{ clientRef: ref, entityId: 1001 }],
      [
        { clientRef: ref, entityId: handle("F") },
        { clientRef: ref, entityId: handle("G") },
      ],
    ]) {
      expect(classifyMutationResponse(
        bound,
        response(200, {
          result: {},
          receipt: completedReceipt(bound.invocation),
          mappings,
        }),
      )).toEqual({ _tag: "Retry", reason: "malformed" });
    }
  });

  test("a 200 whose result is absent is not a commit", () => {
    expect(classifyMutationResponse(plain, response(200, {
      receipt: completedReceipt(plain.invocation),
    }))).toEqual({ _tag: "Retry", reason: "malformed" });

    expect(classifyMutationResponse(plain, response(200, {
      result: null,
      receipt: completedReceipt(plain.invocation),
    }))).toEqual({ _tag: "Committed", output: null, mappings: [] });
  });

  test("an invocation that binds nothing commits without mappings", () => {
    expect(classifyMutationResponse(plain, response(200, {
      result: null,
      receipt: completedReceipt(plain.invocation),
    }))).toEqual({ _tag: "Committed", output: null, mappings: [] });
  });

  test("the compatibility answers are non-terminal and typed, never dropped", () => {
    expect(classifyMutationResponse(
      plain,
      response(409, { error: "request rejected", code: "operation_changed" }),
    )).toEqual({ _tag: "UpdateRequired", reason: "operation-changed" });
    expect(classifyMutationResponse(
      plain,
      response(409, { error: "request rejected", code: "invocation_update_required" }),
    )).toEqual({ _tag: "UpdateRequired", reason: "invocation-update-required" });
    expect(classifyMutationResponse(
      plain,
      response(409, { code: "invocation_indeterminate" }),
    )).toEqual({ _tag: "Retry", reason: "indeterminate" });
  });

  const rejectedReceipt = (invocation: string) =>
    ({ version: 2, invocationId: invocation, status: "rejected" }) as const;

  test("a refusal the server bound to a durable receipt is terminal and typed", () => {
    expect(classifyMutationResponse(plain, response(403, {
      error: "unauthorized",
      receipt: rejectedReceipt(plain.invocation),
    }))).toEqual({ _tag: "Rejected", code: "unauthorized" });
    expect(classifyMutationResponse(plain, response(400, {
      error: "invalid request",
      receipt: rejectedReceipt(plain.invocation),
    }))).toEqual({ _tag: "Rejected", code: "invalid_request" });
    expect(classifyMutationResponse(plain, response(409, {
      tag: "OperationRejected",
      message: "domain refused",
      receipt: rejectedReceipt(plain.invocation),
    }))).toEqual({ _tag: "Rejected", code: "operation_rejected" });

    expect(classifyMutationResponse(plain, response(500, {
      code: "invocation_failed",
      receipt: { version: 2, invocationId: plain.invocation, status: "failed" },
    }))).toEqual({ _tag: "Rejected", code: "invocation_failed" });

    expect(classifyMutationResponse(
      plain,
      response(409, { code: "invocation_conflict" }),
    )).toEqual({ _tag: "Rejected", code: "invocation_conflict" });
  });

  test("a refusal with no receipt of its own never removes durable work", () => {
    for (const status of [400, 401, 403] as const) {
      expect(classifyMutationResponse(plain, response(status, { error: "no" })))
        .toEqual({ _tag: "Retry", reason: "malformed" });
    }

    expect(classifyMutationResponse(plain, response(409, { error: "no" })))
      .toEqual({ _tag: "Refused", code: undefined });

    expect(classifyMutationResponse(plain, response(403, {
      error: "unauthorized",
      receipt: rejectedReceipt("iv1_00000000-0000-7000-8000-000000000000"),
    }))).toEqual({ _tag: "Retry", reason: "malformed" });

    expect(classifyMutationResponse(plain, response(409, {
      receipt: { version: 2, invocationId: plain.invocation, status: "completed" },
    }))).toEqual({ _tag: "Retry", reason: "malformed" });
  });

  test("a 409 code this build does not know stays queued", () => {
    expect(classifyMutationResponse(
      plain,
      response(409, { error: "request rejected", code: "invocation_paused" }),
    )).toEqual({ _tag: "Refused", code: "invocation_paused" });

    expect(classifyMutationResponse(plain, response(409, {
      code: "invocation_paused",
      receipt: rejectedReceipt(plain.invocation),
    }))).toEqual({ _tag: "Rejected", code: "invocation_paused" });
  });

  test("a transport failure or an uninterpretable answer holds the head", () => {
    expect(classifyMutationResponse(plain, { _tag: "Unreachable" }))
      .toEqual({ _tag: "Retry", reason: "unreachable" });
    expect(classifyMutationResponse(plain, response(503, undefined)))
      .toEqual({ _tag: "Retry", reason: "unavailable" });
    expect(classifyMutationResponse(plain, response(500, undefined)))
      .toEqual({ _tag: "Retry", reason: "unavailable" });
    expect(classifyMutationResponse(plain, response(429, {})))
      .toEqual({ _tag: "Retry", reason: "unavailable" });
    expect(classifyMutationResponse(plain, response(200, "not an object")))
      .toEqual({ _tag: "Retry", reason: "malformed" });
    expect(classifyMutationResponse(plain, response(418, {})))
      .toEqual({ _tag: "Retry", reason: "malformed" });
  });
});
