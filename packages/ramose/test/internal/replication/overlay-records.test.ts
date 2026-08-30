/**
 * The durable layer record and the restore decision (#476 slice 2).
 *
 * Everything here is a pure value: the record the enqueue writes, the strict
 * decoder that gates it, and the total decision that turns stored rows back
 * into layers by natively replaying the installed projection. The IndexedDB
 * half — atomicity, the crash cuts, the scoped clear, and the fence
 * transaction — is proven in an actual browser.
 */

import { describe, expect, test } from "bun:test";
import {
  runProjection,
  type ProjectionField,
  type ProjectionTx,
} from "../../../src/db/Projection.ts";
import {
  clientRef,
  invocationId,
  type ClientRef,
  type EntityId,
  type InvocationId,
} from "../../../src/db/refs.ts";
import type { OperationVersion } from "../../../src/internal/authorization/identities.ts";
import {
  base64Url,
  sealEntityId,
  type EntityIdScope,
  type ServerSealingKey,
} from "../../../src/internal/replication/index.ts";
import {
  buildOutboxRecord,
  type OutboxDraft,
  type OutboxRecord,
} from "../../../src/internal/replication/outbox.ts";
import {
  buildOptimisticLayer,
  decodeOptimisticLayer,
  declaredRefs,
  layerOf,
  restoreOverlayLayers,
  withLayerState,
  type LayerRestoration,
  type OptimisticLayerRecord,
} from "../../../src/internal/replication/overlay-records.ts";
import {
  makeClientProjectionCatalog,
  type InstalledProjection,
} from "../../../src/internal/replication/projection-binding.ts";
import type { OverlayLayer } from "../../../src/internal/replication/overlay-layers.ts";
import type { ReplicaDatabaseScope } from "../../../src/internal/replication/replica-lifecycle.ts";

const opaque = (character: string): string => character.repeat(43);

const receiver: ReplicaDatabaseScope = {
  server: opaque("s"),
  principal: opaque("p"),
  database: opaque("d"),
};

const SCOPE_KEY = "ramose-replica-scope-v2:server:principal";
const version = "b".repeat(64) as OperationVersion;

const operation = {
  catalog: "movies" as never,
  owner: { kind: "entity", name: "issue" } as const,
  localName: "rename",
};

const title: ProjectionField = { ident: ":issue/title", valueType: "string" };

const draft = (overrides: Partial<OutboxDraft> = {}): OutboxDraft => ({
  invocation: invocationId(),
  receiver,
  operation,
  operationVersion: version,
  target: { type: "none" },
  input: { title: "offline" },
  allocations: [],
  inputRefs: [],
  enqueuedAt: 1_700_000_000_000,
  ...overrides,
});

const queued = (
  overrides: Partial<OutboxDraft> = {},
  sequence = 1,
): OutboxRecord => buildOutboxRecord(draft(overrides), SCOPE_KEY, sequence);

const identity = { revision: 3, build: "build-a" };

const layerRecord = (
  record: OutboxRecord = queued(),
  projection = identity,
): OptimisticLayerRecord =>
  buildOptimisticLayer({ record, projection, createdAt: 1_700_000_000_001 });

/** The projection every catalog below installs, unless a case replaces it. */
const rename = ({ input, self, tx }: {
  readonly input: { readonly title: string };
  readonly self: unknown;
  readonly tx: ProjectionTx;
}): void => {
  tx.set(self as ClientRef, title, input.title);
};

const catalogOf = (
  installed: Partial<InstalledProjection["projection"]> | undefined,
  build = "build-a",
) =>
  makeClientProjectionCatalog(build, [{
    operation,
    projection: installed === undefined
      ? undefined
      : {
        revision: installed.revision ?? 3,
        run: (installed.run ?? rename) as never,
      },
  }]);

const restore = (
  layers: readonly OptimisticLayerRecord[],
  catalog = catalogOf({}),
  keyId?: string,
  unreadable = 0,
): LayerRestoration =>
  restoreOverlayLayers({ layers, unreadable }, {
    catalog,
    keyId,
    run: (projection, record) => {
      const allocations: Record<string, ClientRef> = {};
      for (const allocation of record.allocations) {
        allocations[allocation.slot] = allocation.clientRef;
      }
      const outcome = runProjection<never>(projection, {
        input: record.input as never,
        self: record.target.type === "client-ref"
          ? record.target.clientRef
          : record.target.type === "entity"
            ? record.target.entityId
            : undefined,
        allocations,
      });
      return outcome.type === "changeset"
        ? layerOf(record, outcome.changeset)
        : undefined;
    },
  });

describe("the durable layer record", () => {
  test("takes its position, realm, target and input from the queued record", () => {
    const ref = clientRef();
    const record = queued({ target: { type: "client-ref", clientRef: ref } });
    const layer = layerRecord(record);
    expect(layer).toMatchObject({
      partition: record.partition,
      sequence: record.sequence,
      invocation: record.invocation,
      scope: record.scope,
      operationVersion: version,
      projection: identity,
      target: { type: "client-ref", clientRef: ref },
      input: { title: "offline" },
      state: "queued",
      activation: 0,
      sealing: null,
    });
    expect(layer.refs).toEqual([ref]);
  });

  test("stores no changeset, no callback, and no source of any kind", () => {
    const layer = layerRecord();
    // The whole persisted vocabulary. A changeset, an `ops`, a `source`, a
    // `body`, or anything function-shaped here would be an executable
    // persistence format; there is deliberately none.
    expect(Object.keys(layer).sort()).toEqual([
      "activation",
      "allocations",
      "createdAt",
      "input",
      "invocation",
      "operation",
      "operationVersion",
      "partition",
      "projection",
      "receiver",
      "refs",
      "scope",
      "sealing",
      "sequence",
      "state",
      "target",
    ]);
    expect(JSON.stringify(layer)).not.toContain("function");
  });

  test("carries the declared slot refs and the refs the input supplied", () => {
    const slot = clientRef();
    const supplied = clientRef();
    const record = queued({
      allocations: [{ slot: "draft", clientRef: slot }],
      input: { title: "offline", parent: supplied },
      inputRefs: [{ path: ["parent"], ref: supplied }],
    });
    expect(declaredRefs(layerRecord(record))).toEqual([slot, supplied]);
  });

  test("round-trips through the decoder its own builder ran", () => {
    const layer = layerRecord();
    expect(decodeOptimisticLayer(structuredClone(layer))).toEqual(layer);
  });

  test("refuses a row whose partition names another realm", () => {
    const layer = layerRecord();
    expect(decodeOptimisticLayer({ ...layer, partition: "ramose-mutation-v1:a:b:c" }))
      .toBeUndefined();
  });

  test("refuses a queued row carrying an activation stamp", () => {
    expect(decodeOptimisticLayer({ ...layerRecord(), activation: 4 })).toBeUndefined();
  });

  test("refuses a row whose projection identity is not a declared revision", () => {
    for (const projection of [null, {}, { revision: 0, build: "b" }, { revision: 1, build: "" }]) {
      expect(decodeOptimisticLayer({ ...layerRecord(), projection })).toBeUndefined();
    }
  });

  test("recomputes the sealing epoch from the row's own handles", async () => {
    const sealing: ServerSealingKey = {
      keyId: base64Url(Uint8Array.from({ length: 16 }, (_, index) => index)),
      material: base64Url(Uint8Array.from({ length: 32 }, (_, index) => index * 3)),
    };
    const scope: EntityIdScope = {
      server: receiver.server,
      principal: receiver.principal,
      database: receiver.database,
    };
    const handle = (await sealEntityId(sealing, scope, 7)) as unknown as EntityId;
    const layer = layerRecord(queued({ target: { type: "entity", entityId: handle } }));
    expect(layer.sealing).toEqual({ codecVersion: 1, keyId: sealing.keyId });
    // A row whose `sealing` was rewritten to another epoch is unreadable, not
    // ready: believing the field would let a stale handle look current after a
    // key rotation and skip the very quarantine the epoch exists to trigger.
    expect(decodeOptimisticLayer({
      ...layer,
      sealing: { codecVersion: 1, keyId: base64Url(new Uint8Array(16)) },
    })).toBeUndefined();
  });

  test("a commit retains the row and stamps it; nothing else moves", () => {
    const layer = layerRecord();
    const committed = withLayerState(layer, "committed-unobserved", 5);
    expect(committed).toEqual({
      ...layer,
      state: "committed-unobserved",
      activation: 5,
    });
  });
});

describe("restoring layers by native replay", () => {
  const withTarget = (sequence: number): OptimisticLayerRecord =>
    layerRecord(
      queued({ target: { type: "client-ref", clientRef: clientRef() } }, sequence),
    );

  test("replays the installed projection over the stored input, in FIFO order", () => {
    const first = withTarget(1);
    const restored = restore([withTarget(2), first]);
    expect(restored.type).toBe("layers");
    const layers = (restored as { readonly layers: readonly OverlayLayer[] }).layers;
    expect(layers.map((layer) => layer.sequence)).toEqual([1, 2]);
    expect(layers[0]!.changeset).toEqual([{
      op: "set",
      entity: first.refs[0]!,
      field: ":issue/title",
      value: { type: "string", value: "offline" },
    }]);
    expect(layers[0]!.declared).toEqual(declaredRefs(first));
  });

  test("a committed-unobserved row restores as committed-unobserved, stamped", () => {
    const row = withLayerState(withTarget(1), "committed-unobserved", 6);
    const restored = restore([row]);
    expect((restored as { readonly layers: readonly OverlayLayer[] }).layers[0])
      .toMatchObject({ state: "committed-unobserved", activation: 6 });
  });

  test("a projection that throws contributes no layer and quarantines nothing", () => {
    const restored = restore([withTarget(1)], catalogOf({
      run: (() => {
        throw new Error("authoring mistake");
      }) as never,
    }));
    expect(restored).toEqual({ type: "layers", layers: [] });
  });

  describe("typed update-required, data-free, replica untouched", () => {
    const reasons = (restored: LayerRestoration): readonly string[] =>
      restored.type === "update-required"
        ? restored.quarantined.map((entry) => entry.reason)
        : [];

    test("a rotated projection revision", () => {
      const restored = restore([withTarget(1)], catalogOf({ revision: 4 }));
      expect(restored.type).toBe("update-required");
      expect(reasons(restored)).toEqual(["projection-revision"]);
    });

    test("the installed bundle no longer declares the projection", () => {
      expect(reasons(restore([withTarget(1)], catalogOf(undefined))))
        .toEqual(["projection-missing"]);
    });

    test("the installed bundle no longer declares the operation", () => {
      const empty = makeClientProjectionCatalog("build-a", []);
      expect(reasons(restore([withTarget(1)], empty))).toEqual(["operation-missing"]);
    });

    test("a row this build cannot decode", () => {
      expect(reasons(restore([withTarget(1)], catalogOf({}), undefined, 1)))
        .toEqual(["unreadable-row"]);
    });

    test("one drifted row withholds every layer of its receiver database", () => {
      // Partial replay would show a speculative view the installed bundle
      // cannot account for; the rows stay durable and a compatible build
      // replays them unchanged.
      const restored = restore([withTarget(1), withTarget(2)], catalogOf({ revision: 4 }));
      expect(restored).toMatchObject({ type: "update-required" });
      expect(restored.type === "update-required" && restored.quarantined).toHaveLength(2);
    });

    test("build drift alone rebinds rather than quarantining", () => {
      const restored = restore([withTarget(1)], catalogOf({}, "build-b"));
      expect(restored.type).toBe("layers");
    });
  });

  test("the same rows restore to the same layers, every time", () => {
    const rows = [withTarget(1), withTarget(2)];
    const stringify = (restored: LayerRestoration): string =>
      JSON.stringify(restored);
    expect(stringify(restore(rows))).toBe(stringify(restore(rows)));
  });
});

describe("layerOf", () => {
  test("a queued row has no activation; a committed one carries its stamp", () => {
    const row = layerRecord();
    expect(layerOf(row, []).activation).toBeNull();
    expect(layerOf(withLayerState(row, "committed-unobserved", 2), []).activation)
      .toBe(2);
  });

  test("the layer's invocation is the row's, never a fresh one", () => {
    const row = layerRecord();
    const invocation: InvocationId = row.invocation;
    expect(layerOf(row, []).invocation).toBe(invocation);
  });
});
