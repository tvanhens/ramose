/**
 * The observation-fenced reconciliation driver (#476 slice 2).
 *
 * This is the production caller #475 slice 3 left open. It owns one receiver
 * database's speculative state and composes the three parts that were until now
 * only joined by their types:
 *
 * ```
 *   acknowledgement persisted  →  restart(prior)   close → increment → open
 *   fresh activation opens     →  outcome(n)       the session's own hook
 *   first settled frame        →  settle(n)        the reconciliation transaction
 * ```
 *
 * The order is the contract. The counter is claimed only after the prior
 * generation is closed, so output that was already in flight before the
 * acknowledgement was durable can never be read as evidence that the server's
 * stream reached the commit; and it is claimed *before* the fresh activation
 * opens, so a crash cut can only ever leave the client fencing with a larger
 * number than it needed. Every cut therefore converges.
 *
 * ## What this module does not do
 *
 * It opens no replication session and holds no socket: the caller closes the
 * prior generation and opens the fresh one with {@link
 * OptimisticReconciler.outcome} as its hook. It writes no replica. And it never
 * reads a callback's source — restart replay resolves the projection from the
 * installed client bundle by operation identity and calls it.
 */

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

/**
 * Entity-local pending metadata, derived from the layers and nothing else.
 *
 * Client-internal sidecar state: never a persisted trait, never an application
 * datom, and never a public API — #477 decides what, if anything, of this an
 * application sees. It exists so a caller can ask "is this row still in
 * flight?" without the answer being written into the local view it is asking
 * about.
 */
export type OptimisticPendingEntry = {
  /** The client ref or sealed handle the layers named. */
  readonly ref: MutationRef;
  /** Every invocation still holding optimistic state for this entity. */
  readonly invocations: readonly InvocationId[];
  /**
   * `queued` while any of them is still unanswered; `committed-unobserved` once
   * every one has an authoritative receipt and only the fence is outstanding.
   */
  readonly state: OverlayLayer["state"];
  /** Whether one of those layers brought this entity into the view. */
  readonly created: boolean;
};

export type OptimisticPending = ReadonlyMap<string, OptimisticPendingEntry>;

/**
 * The `.local` sidecar, as a pure function of the ordered layers.
 *
 * Recomputed rather than accumulated, exactly like the overlay itself, so it
 * cannot drift from the layers it describes: removing a layer removes its
 * contribution by construction.
 */
export const pendingLayerState = (layers: OverlayLayers): OptimisticPending => {
  const pending = new Map<string, {
    ref: MutationRef;
    invocations: InvocationId[];
    queued: boolean;
    created: boolean;
  }>();
  for (const layer of layers) {
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

/** Everything one receiver database's speculative state currently is. */
export type OptimisticOverlayState = {
  readonly receiver: ReplicaDatabaseScope;
  /** The layers to apply, in FIFO order. Empty while quarantined. */
  readonly layers: OverlayLayers;
  /**
   * Data-free typed update-required. Non-empty means this receiver database's
   * layers cannot be replayed against the installed bundle or the current
   * sealing epoch — the durable rows are kept, no layer is presented, and the
   * committed replica is untouched.
   */
  readonly updateRequired: readonly LayerQuarantine[];
  readonly pending: OptimisticPending;
  /** The activation currently in force; `0` before the first fresh one. */
  readonly activation: number;
};

export type OptimisticOverlayObserver = (state: OptimisticOverlayState) => void;

/**
 * Exactly the durable surface this driver uses.
 *
 * Structural for the same reason the other two are: to keep the dependency
 * pointing one way. It is not a seam for a substitute store — the durable
 * behavior is proven against real IndexedDB in an actual browser.
 */
export type ReconciliationStore = ActivationFenceStore & {
  readonly optimisticLayers: (
    receiver: ReplicaDatabaseScope,
  ) => Promise<LayerRows>;
  readonly mappedHandles: (
    receiver: ReplicaDatabaseScope,
  ) => Promise<ReadonlyMap<string, EntityId>>;
};

export type ReconciliationOptions = {
  /** The sealing epoch the current authenticated session confirmed, if any. */
  readonly keyId?: string | undefined;
  /**
   * The committed replica's handle-to-local-id binding. Absent until #477 hands
   * an application a handle for a replicated row; until then a layer addressed
   * by a handle this replica holds is refused rather than invented, exactly as
   * the overlay documents.
   */
  readonly entity?: ((id: EntityId) => number | undefined) | undefined;
};

const NO_ENTITY = (): number | undefined => undefined;

/** The invocation's own target, as a projection receives it. */
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

/**
 * Replay one stored row natively.
 *
 * The whole execution model, again: build the context from the durable record,
 * call the callback the installed bundle supplied, take what the builder
 * recorded. A projection that throws contributes no layer rather than a partial
 * one — the invocation stays queued and the local view simply shows nothing
 * optimistic for it, which is what slice 1 froze.
 */
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

/**
 * One receiver database's optimistic layers and their observation fence.
 *
 * Every method is a function of durable rows: nothing is reconstructed from
 * memory, so the state after a restart is identical to the state before one.
 */
export class OptimisticReconciler {
  private readonly fence: ActivationFence;
  private readonly observers = new Set<OptimisticOverlayObserver>();
  private state: OptimisticOverlayState;
  private handles: ReadonlyMap<string, EntityId> = new Map();

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

  /**
   * Reconstruct everything from durable rows.
   *
   * This is restart recovery *and* the ordinary replay after any durable
   * change: the rows are read, the callbacks are resolved from the installed
   * bundle, and each is run natively over its own stored input. Nothing carries
   * a changeset across a restart, so a bundle whose projection has drifted
   * quarantines instead of replaying code the author has disowned.
   */
  async refresh(): Promise<OptimisticOverlayState> {
    const [rows, handles] = await Promise.all([
      this.store.optimisticLayers(this.receiver),
      this.store.mappedHandles(this.receiver),
    ]);
    this.handles = handles;
    await this.fence.refresh();
    return this.publish(rows);
  }

  /**
   * Close the prior replication generation and claim the activation that
   * replaces it, in the one order the fence requires. Call it once the
   * acknowledgement is durable.
   */
  async restart(
    prior?: { readonly close: () => Promise<void> } | undefined,
  ): Promise<number> {
    const activation = await this.fence.restart(prior);
    await this.refresh();
    return activation;
  }

  /**
   * The replication-session hook for one activation.
   *
   * On the first settled frame of activation `n` it runs the reconciliation
   * transaction and then replays the layer order that transaction left. A hook
   * that throws leaves the activation unfenced and the next settled frame tries
   * again; observation is downstream of persistence and never fails a session.
   */
  outcome(activation: number): () => Promise<void> {
    return async () => {
      const outcome = await this.fence.settle(activation);
      if (outcome !== undefined) await this.applyFence(outcome);
    };
  }

  /** The activation currently in force. */
  activation(): number {
    return this.fence.snapshot().activation;
  }

  /**
   * React to one submission pass.
   *
   * A commit needs a *fresh* activation before its layer can ever be fenced, so
   * the prior generation is closed and the counter moves. A rejection needs no
   * replication at all: the acknowledgement transaction already removed exactly
   * that one layer, so the later ones are replayed immediately. Everything else
   * changes nothing.
   */
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

  /**
   * The two lookups the overlay cannot perform itself, over one fixed snapshot.
   *
   * Stable for the duration of a call by construction: the map is replaced
   * wholesale by {@link OptimisticReconciler.refresh}, never mutated.
   */
  resolver(): OverlayResolver {
    const handles = this.handles;
    return Object.freeze({
      entity: this.options.entity ?? NO_ENTITY,
      mapping: (ref: ClientRef): EntityId | undefined => handles.get(ref),
    });
  }

  /** The local view: the committed value plus this database's layers. */
  view(committed: Db): Promise<OverlayView> {
    return projectOverlay(committed, this.state.layers, this.resolver());
  }

  /**
   * Adopt the layer order one reconciliation transaction left.
   *
   * The rows come from inside that transaction, so the replay is over exactly
   * what it committed rather than over a second read a concurrent enqueue could
   * already have changed.
   */
  private async applyFence(outcome: ActivationFenceOutcome): Promise<void> {
    // The fence itself writes no mapping, but an acknowledgement may have
    // landed while this activation was open, so a surviving layer's ref may
    // have become mapped. A failed re-read is not a reason to withhold the
    // fence's own result: the layers it left are already durable, and the next
    // refresh picks the mappings up.
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
    });
    for (const observer of this.observers) this.notify(observer);
    return this.state;
  }

  private notify(observer: OptimisticOverlayObserver): void {
    try {
      observer(this.state);
    } catch {
      // Observation is downstream of persistence and cannot stop reconciliation.
    }
  }
}
