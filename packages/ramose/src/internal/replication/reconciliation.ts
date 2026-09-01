import type { Db } from "../core/db.ts";
import {
  runProjection,
  type AnyOptimisticProjection,
} from "../../db/Projection.ts";
import type { ClientRef, EntityId, InvocationId, MutationRef } from "../../db/refs.ts";
import {
  ActivationFence,
  requiresActivationFence,
  type ActivationFenceStore,
} from "./activation-fence.ts";
import {
  emptyOverlayLayers,
  type OverlayLayer,
  type OverlayLayers,
} from "./overlay-layers.ts";
import {
  layerOf,
  restoreOverlayLayers,
  type LayerQuarantine,
  type LayerRows,
  type OptimisticLayerRecord,
} from "./overlay-records.ts";
import {
  projectOverlay,
  type OverlayResolver,
  type OverlayView,
} from "./overlay.ts";
import type { ActivationFenceOutcome } from "./outbox-storage.ts";
import type { ClientProjectionCatalog } from "./projection-binding.ts";
import type { ReplicaDatabaseScope } from "./replica-lifecycle.ts";
import type { QueueProgress } from "./submission.ts";

export type OptimisticPendingEntry = {
  readonly ref: MutationRef;
  readonly invocations: readonly InvocationId[];
  readonly state: OverlayLayer["state"];
  readonly created: boolean;
};

export type OptimisticPending = ReadonlyMap<string, OptimisticPendingEntry>;

export const pendingLayerState = (layers: OverlayLayers): OptimisticPending => {
  const pending = new Map<string, {
    ref: MutationRef;
    invocations: InvocationId[];
    queued: boolean;
    created: boolean;
  }>();
  for (const layer of layers) {
    if (layer.state === "retired") continue;
    for (const op of layer.changeset) {
      const refs: MutationRef[] = [op.entity];
      if ((op.op === "set" || op.op === "remove") && op.value?.type === "ref") {
        refs.push(op.value.value);
      }
      for (const ref of refs) {
        const entry = pending.get(ref) ??
          { ref, invocations: [], queued: false, created: false };
        if (!entry.invocations.includes(layer.invocation)) {
          entry.invocations.push(layer.invocation);
        }
        if (layer.state === "queued") entry.queued = true;
        if (op.op === "create" && op.entity === ref) entry.created = true;
        pending.set(ref, entry);
      }
    }
  }
  return new Map(
    [...pending].map(([ref, entry]) => [
      ref,
      Object.freeze({
        ref: entry.ref,
        invocations: Object.freeze([...entry.invocations]),
        state: (entry.queued ? "queued" : "committed-unobserved") as OverlayLayer["state"],
        created: entry.created,
      }),
    ] as const),
  );
};

export type OptimisticOverlayState = {
  readonly receiver: ReplicaDatabaseScope;
  readonly layers: OverlayLayers;
  readonly updateRequired: readonly LayerQuarantine[];
  readonly pending: OptimisticPending;
  readonly activation: number;
  readonly settlements: ReadonlyMap<InvocationId, number>;
};

export type OptimisticOverlayObserver = (state: OptimisticOverlayState) => void;

export type ReconciliationStore = ActivationFenceStore & {
  readonly optimisticLayers: (
    receiver: ReplicaDatabaseScope,
  ) => Promise<LayerRows>;
  readonly mappedHandles: (
    receiver: ReplicaDatabaseScope,
  ) => Promise<ReadonlyMap<string, EntityId>>;
  readonly sweepDurableLayers: (
    receiver: ReplicaDatabaseScope,
  ) => Promise<{ readonly recovered: readonly InvocationId[] }>;
};

export type ReconciliationOptions = {
  readonly keyId?: string | undefined;
  readonly entity?: ((id: EntityId) => number | undefined) | undefined;
};

const NO_ENTITY = (): number | undefined => undefined;

const targetOf = (record: OptimisticLayerRecord): MutationRef | undefined => {
  switch (record.target.type) {
    case "entity":
      return record.target.entityId;
    case "client-ref":
      return record.target.clientRef;
    case "none":
      return undefined;
  }
};

const replayLayer = (
  projection: AnyOptimisticProjection,
  record: OptimisticLayerRecord,
): OverlayLayer | undefined => {
  const allocations: Record<string, ClientRef> = {};
  for (const allocation of record.allocations) {
    allocations[allocation.slot] = allocation.clientRef;
  }
  const outcome = runProjection<never>(projection, {
    input: record.input as never,
    self: targetOf(record),
    allocations,
  });
  return outcome.type === "changeset"
    ? layerOf(record, outcome.changeset)
    : undefined;
};

export class OptimisticReconciler {
  private readonly fence: ActivationFence;
  private readonly observers = new Set<OptimisticOverlayObserver>();
  private state: OptimisticOverlayState;
  private handles: ReadonlyMap<string, EntityId> = new Map();
  private refreshing: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: ReconciliationStore,
    private readonly receiver: ReplicaDatabaseScope,
    private readonly catalog: ClientProjectionCatalog,
    private readonly options: ReconciliationOptions = {},
  ) {
    this.fence = new ActivationFence(store, receiver);
    this.state = Object.freeze({
      receiver,
      layers: emptyOverlayLayers,
      updateRequired: Object.freeze([]),
      pending: new Map(),
      activation: 0,
      settlements: new Map(),
    });
  }

  snapshot(): OptimisticOverlayState {
    return this.state;
  }

  observe(observer: OptimisticOverlayObserver): () => void {
    this.observers.add(observer);
    this.notify(observer);
    return () => this.observers.delete(observer);
  }

  refresh(): Promise<OptimisticOverlayState> {
    const next = this.refreshing.then(
      () => this.readDurableLayers(),
      () => this.readDurableLayers(),
    );
    this.refreshing = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async readDurableLayers(): Promise<OptimisticOverlayState> {
    await this.store.sweepDurableLayers(this.receiver).catch(() => undefined);
    const [rows, handles] = await Promise.all([
      this.store.optimisticLayers(this.receiver),
      this.store.mappedHandles(this.receiver),
    ]);
    this.handles = handles;
    await this.fence.refresh();
    return this.publish(rows);
  }

  async restart(
    prior?: { readonly close: () => Promise<void> } | undefined,
  ): Promise<number> {
    const activation = await this.fence.restart(prior);
    await this.refresh();
    return activation;
  }

  outcome(activation: number): () => Promise<void> {
    return async () => {
      const outcome = await this.fence.settle(activation);
      if (outcome !== undefined) await this.applyFence(outcome);
    };
  }

  mappings(): ReadonlyMap<string, EntityId> {
    return this.handles;
  }

  activation(): number {
    return this.fence.snapshot().activation;
  }

  async reconcile(
    progress: readonly QueueProgress[],
    prior?: { readonly close: () => Promise<void> } | undefined,
  ): Promise<void> {
    const mine = progress.filter((entry) =>
      entry.receiver.server === this.receiver.server &&
      entry.receiver.principal === this.receiver.principal &&
      entry.receiver.database === this.receiver.database
    );
    if (mine.some(requiresActivationFence)) {
      await this.restart(prior);
      return;
    }
    if (mine.some((entry) => entry.state._tag === "Rejected")) {
      await this.refresh();
    }
  }

  resolver(): OverlayResolver {
    const handles = this.handles;
    return Object.freeze({
      entity: this.options.entity ?? NO_ENTITY,
      mapping: (ref: ClientRef): EntityId | undefined => handles.get(ref),
    });
  }

  view(committed: Db, layers: OverlayLayers = this.state.layers): Promise<OverlayView> {
    return projectOverlay(committed, layers, this.resolver());
  }

  private async applyFence(outcome: ActivationFenceOutcome): Promise<void> {
    this.handles = await this.store.mappedHandles(this.receiver)
      .catch(() => this.handles);
    this.publish({ layers: outcome.layers, unreadable: outcome.unreadable });
  }

  private publish(rows: LayerRows): OptimisticOverlayState {
    const restoration = restoreOverlayLayers(rows, {
      catalog: this.catalog,
      keyId: this.options.keyId,
      run: replayLayer,
    });
    const layers = restoration.type === "layers"
      ? Object.freeze(restoration.layers)
      : emptyOverlayLayers;
    this.state = Object.freeze({
      receiver: this.receiver,
      layers,
      updateRequired: restoration.type === "layers"
        ? Object.freeze([])
        : restoration.quarantined,
      pending: pendingLayerState(layers),
      activation: this.fence.snapshot().activation,
      settlements: this.fence.snapshot().settlements,
    });
    for (const observer of this.observers) this.notify(observer);
    return this.state;
  }

  private notify(observer: OptimisticOverlayObserver): void {
    try {
      observer(this.state);
    } catch {
    }
  }
}
