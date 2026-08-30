import { describe, expect, test } from "bun:test";
import {
  allocatedEids,
  decideEpoch,
  extractAllocations,
  inputEntityRefHandles,
  isEntityRefPath,
  mayCarrySealedEntityId,
  outputEntityRefPaths,
  parseEntityIdScope,
  parseInvocationAllocations,
  resolveSealedInputRefs,
  resolveSealedTarget,
  sameEpochScope,
  sealAllocationMappings,
  sealOutputEntityRefs,
  type InvocationAllocation,
} from "../../../src/internal/authorization/entity-targets.ts";
import type {
  AllocationSlotDescriptor,
  OperationInputShape,
} from "../../../src/internal/authorization/catalog.ts";
import {
  ENTITY_ID_CODEC_VERSION,
  sealEntityId,
  type EntityIdScope,
} from "../../../src/internal/replication/entity-id.ts";
import { base64Url } from "../../../src/internal/replication/server-identity.ts";
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

const stringShape: OperationInputShape = {
  _tag: "scalar",
  valueType: "string",
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

describe("sealing-root epoch coherence", () => {
  const bound = { keyId: sealing.keyId, scope };

  test("one key may act on the scope its own epoch derived", () => {
    expect(decideEpoch(bound, sealing)).toEqual({
      _tag: "Agreed",
      sealing,
      scope,
    });

    expect(decideEpoch(bound, { ...sealing, keyId: sealing.keyId })._tag)
      .toBe("Agreed");
  });

  test("a moved epoch is a quarantine, never a denial", () => {

    expect(decideEpoch(bound, rotatedSealing)).toEqual({ _tag: "UpdateRequired" });
  });

  test("two epoch-bound scopes agree only on every component and the epoch", () => {
    expect(sameEpochScope(bound, { keyId: sealing.keyId, scope: { ...scope } }))
      .toBe(true);
    expect(sameEpochScope(bound, { keyId: rotatedSealing.keyId, scope }))
      .toBe(false);
    for (const component of ["server", "principal", "database"] as const) {
      expect(sameEpochScope(bound, {
        keyId: sealing.keyId,
        scope: { ...scope, [component]: "elsewhere" },
      })).toBe(false);
    }
  });

  test("a scope from one epoch and a key from another seal nothing openable", async () => {

    const underRotated = await sealEntityId(rotatedSealing, scope, 4242);
    expect(await resolveSealedTarget(sealing, scope, underRotated))
      .toEqual({ _tag: "UpdateRequired" });
    const otherScopeToken = await sealEntityId(sealing, otherScope, 4242);
    expect(await resolveSealedTarget(sealing, scope, otherScopeToken))
      .toEqual({ _tag: "Denied" });
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

    expect(isEntityRefPath(outputShape, ["count"])).toBe(false);
    expect(isEntityRefPath(outputShape, ["absent"])).toBe(false);
    expect(isEntityRefPath(outputShape, ["rows", "0"])).toBe(false);
    expect(isEntityRefPath(outputShape, ["id", "deeper"])).toBe(false);
  });
});

describe("extractAllocations", () => {
  const output = { id: 42, count: 7, rows: [11, 12] };

  const allocated = allocatedEids({ "__ramose.operation/1": 42, item: 11, other: 12 });

  test("reads only the slots the caller bound, at the declared ref path", () => {
    const item = ref();
    const first = ref();
    expect(extractAllocations(declared, outputShape, output, [
      { slot: "first", clientRef: first },
      { slot: "item", clientRef: item },
    ], allocated)).toEqual({
      _tag: "Allocated",
      slots: [{ slot: "first", eid: 11 }, { slot: "item", eid: 42 }],
    });
  });

  test("a slot declared on a non-ref position never binds", () => {
    expect(extractAllocations(declared, outputShape, output, [
      { slot: "count", clientRef: ref() },
    ], allocated)).toEqual({ _tag: "Unallocated", slot: "count" });
  });

  test("a slot whose declared path the output does not deliver never binds", () => {
    expect(extractAllocations(declared, outputShape, output, [
      { slot: "missing", clientRef: ref() },
    ], allocated)).toEqual({ _tag: "Unallocated", slot: "missing" });
    expect(extractAllocations(declared, outputShape, { count: 7, rows: [] }, [
      { slot: "item", clientRef: ref() },
    ], allocated)).toEqual({ _tag: "Unallocated", slot: "item" });
  });

  test("a slot the operation does not declare never binds", () => {
    expect(extractAllocations([], outputShape, output, [
      { slot: "item", clientRef: ref() },
    ], allocated)).toEqual({ _tag: "Unallocated", slot: "item" });
  });

  test("a slot naming an entity this transaction did not allocate never binds", () => {

    expect(extractAllocations(declared, outputShape, output, [
      { slot: "item", clientRef: ref() },
    ], allocatedEids({}))).toEqual({ _tag: "Unallocated", slot: "item" });
    expect(extractAllocations(declared, outputShape, output, [
      { slot: "first", clientRef: ref() },
    ], allocatedEids({ self: 42 }))).toEqual({ _tag: "Unallocated", slot: "first" });
  });

  test("an upsert that resolved a tempid to an existing row still allocates", () => {

    expect(extractAllocations(declared, outputShape, output, [
      { slot: "item", clientRef: ref() },
    ], allocatedEids({ upserted: 42 }))).toEqual({
      _tag: "Allocated",
      slots: [{ slot: "item", eid: 42 }],
    });
  });

  test("binding nothing allocates nothing", () => {
    expect(extractAllocations(declared, outputShape, output, [], allocated))
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

  test("the boundary between denial and quarantine is the preamble, not the shape", async () => {
    const token = await sealEntityId(sealing, scope, 4242);

    for (const junk of ["!".repeat(55), `${token}=`, "a".repeat(41)]) {
      expect([junk, await resolveSealedTarget(sealing, scope, junk)])
        .toEqual([junk, { _tag: "Denied" }]);
    }

    expect(await resolveSealedTarget(sealing, scope, token.slice(0, 40)))
      .toEqual({ _tag: "Denied" });

    const future = new Uint8Array(41);
    future[0] = ENTITY_ID_CODEC_VERSION + 1;
    expect(await resolveSealedTarget(sealing, scope, base64Url(future)))
      .toEqual({ _tag: "UpdateRequired" });

    expect(await resolveSealedTarget(sealing, scope, clientRef()))
      .toEqual({ _tag: "UpdateRequired" });
  });

  test("a replaced key epoch quarantines data-free instead of denying", async () => {
    const token = await sealEntityId(sealing, scope, 4242);
    expect(await resolveSealedTarget(rotatedSealing, scope, token))
      .toEqual({ _tag: "UpdateRequired" });
  });

  test("a newer codec quarantines even when its envelope is a different size", async () => {

    for (const size of [41, 48, 64]) {
      const envelope = new Uint8Array(size);
      envelope[0] = ENTITY_ID_CODEC_VERSION + 1;
      expect([size, await resolveSealedTarget(sealing, scope, base64Url(envelope))])
        .toEqual([size, { _tag: "UpdateRequired" }]);
    }
  });

  test("an absurdly long target is denied without being decoded", async () => {

    expect(await resolveSealedTarget(sealing, scope, "A".repeat(100_000)))
      .toEqual({ _tag: "Denied" });
    expect(await resolveSealedTarget(sealing, scope, "")).toEqual({ _tag: "Denied" });
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

describe("entity references in client-visible output", () => {
  const output = { id: 4242, count: 7, rows: [11, 12] };

  test("the deployed shape decides which positions hold a reference", () => {

    expect(outputEntityRefPaths(outputShape, output)).toEqual([
      ["id"],
      ["rows", 0],
      ["rows", 1],
    ]);
    expect(outputEntityRefPaths(scalarShape, 7)).toEqual([]);
    expect(outputEntityRefPaths(outputShape, { count: 7, rows: [] })).toEqual([]);
  });

  test("a position the shape declares but the value does not fill is not sealed", () => {

    expect(outputEntityRefPaths(outputShape, { id: "already-sealed", rows: [] }))
      .toEqual([]);
    expect(outputEntityRefPaths(outputShape, { id: null, rows: [null] })).toEqual([]);
  });

  test("every reference becomes the same handle its allocation mapping carries", async () => {
    const paths = outputEntityRefPaths(outputShape, output);
    const sealed = await sealOutputEntityRefs(sealing, scope, output, paths) as {
      readonly id: string;
      readonly count: number;
      readonly rows: readonly string[];
    };
    expect(isEntityId(sealed.id)).toBe(true);
    expect(sealed.id).toBe(await sealEntityId(sealing, scope, 4242));

    expect(sealed.id).toBe(
      (await sealAllocationMappings(sealing, scope, [{ slot: "item", eid: 4242 }], [
        { slot: "item", clientRef: ref() },
      ]))[0]!.entityId,
    );
    expect(sealed.rows.every(isEntityId)).toBe(true);

    expect(sealed.count).toBe(7);

    expect(output).toEqual({ id: 4242, count: 7, rows: [11, 12] });
    expect(JSON.stringify(sealed)).not.toContain("4242");
    expect(JSON.stringify(sealed)).not.toContain("11");
  });

  test("a wrong scope produces a different handle, and a rotated key another", async () => {
    const paths = outputEntityRefPaths(outputShape, output);
    const here = await sealOutputEntityRefs(sealing, scope, output, paths) as {
      readonly id: string;
    };
    const elsewhere = await sealOutputEntityRefs(sealing, otherScope, output, paths) as {
      readonly id: string;
    };
    const rotated = await sealOutputEntityRefs(rotatedSealing, scope, output, paths) as {
      readonly id: string;
    };
    expect(here.id).not.toBe(elsewhere.id);
    expect(here.id).not.toBe(rotated.id);
  });

  test("a path the value cannot follow is a defect, never a silent skip", async () => {

    await expect(
      sealOutputEntityRefs(sealing, scope, output, [["absent"]]),
    ).rejects.toThrow(/entity-reference position/);
    await expect(
      sealOutputEntityRefs(sealing, scope, output, [["rows", 9]]),
    ).rejects.toThrow(/entity-reference position/);
    await expect(
      sealOutputEntityRefs(sealing, scope, output, [["count", "deeper"]]),
    ).rejects.toThrow(/entity-reference position/);
  });
});

describe("sealed handles at declared input entity-ref positions", () => {
  const inputShape: OperationInputShape = {
    _tag: "struct",
    fields: [
      { key: "count", optional: false, shape: scalarShape },
      { key: "item", optional: false, shape: refShape },
      { key: "note", optional: false, shape: stringShape },
      { key: "rows", optional: false, shape: { _tag: "array", items: refShape } },
    ],
  };

  const handleFor = (eid: number) => sealEntityId(sealing, scope, eid);

  test("only declared ref positions holding a string are candidates", async () => {
    const handle = await handleFor(4242);
    expect(inputEntityRefHandles(inputShape, {
      count: 7,
      item: handle,

      note: handle,
      rows: [handle, await handleFor(11)],
    })).toEqual([["item"], ["rows", 0], ["rows", 1]]);

    expect(inputEntityRefHandles(inputShape, {
      count: 7,
      item: 4242,
      note: handle,
      rows: [],
    })).toEqual([]);
    expect(inputEntityRefHandles(scalarShape, "not-a-ref-position")).toEqual([]);
  });

  test("an input that is itself a ref addresses the root position", async () => {
    const handle = await handleFor(4242);
    expect(inputEntityRefHandles(refShape, handle)).toEqual([[]]);
    const resolved = await resolveSealedInputRefs(sealing, scope, handle, [[]]);
    expect(resolved).toEqual({ _tag: "Resolved", input: 4242 });
    expect(inputEntityRefHandles(refShape, 4242)).toEqual([]);
  });

  test("mixed numeric and sealed positions resolve to one numeric input", async () => {
    const input = {
      count: 7,
      item: await handleFor(4242),
      note: await handleFor(4242),
      rows: [11, await handleFor(12)],
    };
    const paths = inputEntityRefHandles(inputShape, input);
    const resolved = await resolveSealedInputRefs(sealing, scope, input, paths);
    expect(resolved._tag).toBe("Resolved");
    if (resolved._tag !== "Resolved") throw new Error("expected Resolved");

    expect(resolved.input).toEqual({
      count: 7,
      item: 4242,
      note: input.note,
      rows: [11, 12],
    });

    expect(input.item).toBe(await handleFor(4242));
  });

  test("an unreadable codec version or key epoch quarantines, everything else denies", async () => {
    const withItem = async (item: string) => {
      const input = { count: 7, item, note: "", rows: [] };
      return resolveSealedInputRefs(
        sealing,
        scope,
        input,
        inputEntityRefHandles(inputShape, input),
      );
    };
    const preamble = (version: number) => {
      const envelope = new Uint8Array(41);
      envelope[0] = version;
      for (let index = 1; index < 17; index++) envelope[index] = 0xa5;
      return base64Url(envelope);
    };
    expect(await withItem(preamble(ENTITY_ID_CODEC_VERSION + 1)))
      .toEqual({ _tag: "UpdateRequired" });
    expect(await withItem(preamble(ENTITY_ID_CODEC_VERSION)))
      .toEqual({ _tag: "UpdateRequired" });

    const handle = await handleFor(4242);

    expect(await withItem(await sealEntityId(sealing, otherScope, 4242)))
      .toEqual({ _tag: "Denied" });
    expect(await withItem(await sealEntityId(otherSealing, scope, 4242)))
      .toEqual({ _tag: "Denied" });
    expect(await withItem(handle.slice(0, 40))).toEqual({ _tag: "Denied" });
    expect(await withItem("")).toEqual({ _tag: "Denied" });
  });

  test("the provisioning predicate over-approximates and never under-approximates", async () => {
    const handle = await handleFor(4242);

    expect(mayCarrySealedEntityId({ item: handle })).toBe(true);
    expect(mayCarrySealedEntityId([[{ deep: handle }]])).toBe(true);

    expect(mayCarrySealedEntityId({ item: `${handle}extra` })).toBe(true);

    expect(mayCarrySealedEntityId({ digest: "a".repeat(64) })).toBe(true);

    expect(mayCarrySealedEntityId({ item: handle.slice(0, 24) })).toBe(true);

    expect(mayCarrySealedEntityId({ title: "a short title" })).toBe(false);
    expect(mayCarrySealedEntityId({ title: "a".repeat(22) })).toBe(false);
    expect(mayCarrySealedEntityId({ title: `${"a".repeat(54)}!` })).toBe(false);
    expect(mayCarrySealedEntityId({ count: 4242, ok: true, none: null })).toBe(false);
    expect(mayCarrySealedEntityId(undefined)).toBe(false);
  });

  test("what the predicate refuses, the resolver would have denied anyway", async () => {

    const versioned = (length: number) => {
      const envelope = new Uint8Array(length);
      envelope[0] = ENTITY_ID_CODEC_VERSION + 1;
      for (let index = 1; index < length; index++) envelope[index] = 0xa5;
      return base64Url(envelope);
    };
    for (let bytes = 1; bytes <= 24; bytes++) {
      const token = versioned(bytes);
      const quarantines =
        (await resolveSealedTarget(sealing, scope, token))._tag === "UpdateRequired";
      expect([bytes, mayCarrySealedEntityId(token)]).toEqual([bytes, quarantines]);
    }
  });

  test("a cyclic or deeply nested input terminates rather than exhausting the stack", async () => {

    const cyclic: Record<string, unknown> = { title: "x" };
    cyclic.self = cyclic;
    expect(mayCarrySealedEntityId(cyclic)).toBe(false);

    let deep: unknown = await handleFor(4242);
    for (let level = 0; level < 200_000; level++) deep = [deep];
    expect(mayCarrySealedEntityId(deep)).toBe(true);
  });
});
