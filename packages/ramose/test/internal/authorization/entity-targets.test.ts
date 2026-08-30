import { describe, expect, test } from "bun:test";
import {
  extractAllocations,
  isEntityRefPath,
  parseEntityIdScope,
  parseInvocationAllocations,
  resolveSealedTarget,
  sealAllocationMappings,
  type InvocationAllocation,
} from "../../../src/internal/authorization/entity-targets.ts";
import type {
  AllocationSlotDescriptor,
  OperationInputShape,
} from "../../../src/internal/authorization/catalog.ts";
import {
  sealEntityId,
  type EntityIdScope,
} from "../../../src/internal/replication/entity-id.ts";
import type { ServerSealingKey } from "../../../src/internal/replication/server-identity.ts";
import { clientRef, isEntityId, type ClientRef } from "../../../src/db/refs.ts";

const sealing: ServerSealingKey = Object.freeze({
  keyId: "AAECAwQFBgcICQoLDA0ODw",
  material: "c2VhbGluZy1tYXRlcmlhbC1mb3ItZW50aXR5LXRhcmdldHM",
});

const otherSealing: ServerSealingKey = Object.freeze({
  keyId: "AAECAwQFBgcICQoLDA0ODw",
  material: "YS1jb21wbGV0ZWx5LWRpZmZlcmVudC1zZWFsaW5nLXJvb3Qtdg",
});

const rotatedSealing: ServerSealingKey = Object.freeze({
  keyId: "EBESExQVFhcYGRobHB0eHw",
  material: sealing.material,
});

const scope: EntityIdScope = Object.freeze({
  server: "server-a",
  principal: "principal-a",
  database: "database-a",
});

const otherScope: EntityIdScope = Object.freeze({ ...scope, database: "database-b" });

const ref = (): ClientRef => clientRef();

const refShape: OperationInputShape = {
  _tag: "ref",
  refTarget: { _tag: "untargeted" },
} as OperationInputShape;

const scalarShape: OperationInputShape = {
  _tag: "scalar",
  valueType: "long",
} as OperationInputShape;

const outputShape: OperationInputShape = {
  _tag: "struct",
  fields: [
    { key: "id", optional: false, shape: refShape },
    { key: "count", optional: false, shape: scalarShape },
    {
      key: "rows",
      optional: false,
      shape: { _tag: "array", items: refShape },
    },
  ],
};

const declared: readonly AllocationSlotDescriptor[] = [
  { slot: "item", path: ["id"] },
  { slot: "first", path: ["rows", 0] },
  { slot: "count", path: ["count"] },
  { slot: "missing", path: ["absent"] },
];

describe("parseInvocationAllocations", () => {
  test("orders canonically by slot name so the digest cannot depend on wire order", () => {
    const zebra = ref();
    const apple = ref();
    expect(parseInvocationAllocations([
      { slot: "zebra", clientRef: zebra },
      { slot: "apple", clientRef: apple },
    ])).toEqual([
      { slot: "apple", clientRef: apple },
      { slot: "zebra", clientRef: zebra },
    ]);
  });

  test("an absent binding is the empty list, not a failure", () => {
    expect(parseInvocationAllocations(undefined)).toEqual([]);
  });

  test("refuses a duplicate slot or a duplicate client ref", () => {
    const shared = ref();
    expect(parseInvocationAllocations([
      { slot: "a", clientRef: shared },
      { slot: "a", clientRef: ref() },
    ])).toBeUndefined();
    expect(parseInvocationAllocations([
      { slot: "a", clientRef: shared },
      { slot: "b", clientRef: shared },
    ])).toBeUndefined();
  });

  test("refuses a bad slot name, a non-client-ref, and extra keys", () => {
    expect(parseInvocationAllocations([{ slot: "0bad", clientRef: ref() }]))
      .toBeUndefined();
    expect(parseInvocationAllocations([{ slot: "a", clientRef: "not-a-ref" }]))
      .toBeUndefined();
    expect(parseInvocationAllocations([
      { slot: "a", clientRef: ref(), extra: 1 },
    ])).toBeUndefined();
    expect(parseInvocationAllocations("nope")).toBeUndefined();
  });
});

describe("parseEntityIdScope", () => {
  test("accepts exactly the three stable components", () => {
    expect(parseEntityIdScope({ ...scope })).toEqual(scope);
  });

  test("a missing or empty component is not a scope", () => {
    expect(parseEntityIdScope({ server: "a", principal: "b" })).toBeUndefined();
    expect(parseEntityIdScope({ ...scope, database: "" })).toBeUndefined();
    expect(parseEntityIdScope(undefined)).toBeUndefined();
  });
});

describe("isEntityRefPath", () => {
  test("only an entity-reference position is addressable", () => {
    expect(isEntityRefPath(outputShape, ["id"])).toBe(true);
    expect(isEntityRefPath(outputShape, ["rows", 0])).toBe(true);
    // The decoded value is a number either way; the shape is what makes the
    // declaration real.
    expect(isEntityRefPath(outputShape, ["count"])).toBe(false);
    expect(isEntityRefPath(outputShape, ["absent"])).toBe(false);
    expect(isEntityRefPath(outputShape, ["rows", "0"])).toBe(false);
    expect(isEntityRefPath(outputShape, ["id", "deeper"])).toBe(false);
  });
});

describe("extractAllocations", () => {
  const output = { id: 42, count: 7, rows: [11, 12] };

  test("reads only the slots the caller bound, at the declared ref path", () => {
    const item = ref();
    const first = ref();
    expect(extractAllocations(declared, outputShape, output, [
      { slot: "first", clientRef: first },
      { slot: "item", clientRef: item },
    ])).toEqual({
      _tag: "Allocated",
      slots: [{ slot: "first", eid: 11 }, { slot: "item", eid: 42 }],
    });
  });

  test("a slot declared on a non-ref position never binds", () => {
    expect(extractAllocations(declared, outputShape, output, [
      { slot: "count", clientRef: ref() },
    ])).toEqual({ _tag: "Unallocated", slot: "count" });
  });

  test("a slot whose declared path the output does not deliver never binds", () => {
    expect(extractAllocations(declared, outputShape, output, [
      { slot: "missing", clientRef: ref() },
    ])).toEqual({ _tag: "Unallocated", slot: "missing" });
    expect(extractAllocations(declared, outputShape, { count: 7, rows: [] }, [
      { slot: "item", clientRef: ref() },
    ])).toEqual({ _tag: "Unallocated", slot: "item" });
  });

  test("a slot the operation does not declare never binds", () => {
    expect(extractAllocations([], outputShape, output, [
      { slot: "item", clientRef: ref() },
    ])).toEqual({ _tag: "Unallocated", slot: "item" });
  });

  test("binding nothing allocates nothing", () => {
    expect(extractAllocations(declared, outputShape, output, []))
      .toEqual({ _tag: "Allocated", slots: [] });
  });
});

describe("resolveSealedTarget", () => {
  test("resolves a handle minted for the same root and scope", async () => {
    const token = await sealEntityId(sealing, scope, 4242);
    expect(await resolveSealedTarget(sealing, scope, token))
      .toEqual({ _tag: "Resolved", eid: 4242 });
  });

  test("another database's scope is the ordinary sealed denial", async () => {
    const token = await sealEntityId(sealing, otherScope, 4242);
    expect(await resolveSealedTarget(sealing, scope, token))
      .toEqual({ _tag: "Denied" });
  });

  test("another sealing root is the ordinary sealed denial", async () => {
    const token = await sealEntityId(otherSealing, scope, 4242);
    expect(await resolveSealedTarget(sealing, scope, token))
      .toEqual({ _tag: "Denied" });
  });

  test("a tampered handle is the ordinary sealed denial", async () => {
    const token = await sealEntityId(sealing, scope, 4242);
    const flipped = `${token.slice(0, 40)}${token[40] === "A" ? "B" : "A"}${token.slice(41)}`;
    expect(await resolveSealedTarget(sealing, scope, flipped))
      .toEqual({ _tag: "Denied" });
  });

  test("a value that is not a sealed handle at all is denied without a key", async () => {
    expect(await resolveSealedTarget(sealing, scope, "cr1_not-a-handle"))
      .toEqual({ _tag: "Denied" });
  });

  test("a replaced key epoch quarantines data-free instead of denying", async () => {
    const token = await sealEntityId(sealing, scope, 4242);
    expect(await resolveSealedTarget(rotatedSealing, scope, token))
      .toEqual({ _tag: "UpdateRequired" });
  });
});

describe("sealAllocationMappings", () => {
  const bound = (): readonly InvocationAllocation[] => [
    { slot: "item", clientRef: ref() },
  ];

  test("seals each allocated eid and binds it to its slot's client ref", async () => {
    const requested = bound();
    const mappings = await sealAllocationMappings(
      sealing,
      scope,
      [{ slot: "item", eid: 4242 }],
      requested,
    );
    expect(mappings).toHaveLength(1);
    expect(mappings[0]!.clientRef).toBe(requested[0]!.clientRef);
    expect(isEntityId(mappings[0]!.entityId)).toBe(true);
    expect(mappings[0]!.entityId).toBe(await sealEntityId(sealing, scope, 4242));
  });

  test("sealing is deterministic, so an exact replay reproduces the bytes", async () => {
    const requested = bound();
    const slots = [{ slot: "item", eid: 9 }];
    expect(await sealAllocationMappings(sealing, scope, slots, requested))
      .toEqual(await sealAllocationMappings(sealing, scope, slots, requested));
  });

  test("an allocated slot with no bound client ref is a defect, not a mapping", async () => {
    await expect(
      sealAllocationMappings(sealing, scope, [{ slot: "ghost", eid: 1 }], bound()),
    ).rejects.toThrow("allocated slot has no bound client ref");
  });
});
