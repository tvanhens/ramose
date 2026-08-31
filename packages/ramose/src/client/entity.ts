import * as Data from "effect/Data";
import type { AnyComposer } from "../db/Composer.ts";
import type { AnyEntity } from "../db/Entity.ts";
import { isClientRef, type ClientRef, type MutationRef } from "../db/refs.ts";
import type { OptimisticPending } from "../internal/replication/reconciliation.ts";
import type { ClientDatabase } from "./database.ts";
import { mutationNamespace, type MutationContext } from "./mutation.ts";
import type { MutationMethod, MutationNamespace } from "./mutation-schema.ts";
import type { ClientOperation } from "./operations.ts";

/**
 * The sidecar state of one entity, derived from the optimistic layers and
 * nothing else.
 *
 * Never a persisted trait, never an application datom, and never part of
 * `.data`: it describes what this *client* is still carrying for the entity,
 * so it must not be confused with what the entity *is*.
 */
export type EntityLocal = {
  readonly pending: boolean;
  readonly created: boolean;
};

const SETTLED: EntityLocal = Object.freeze({ pending: false, created: false });

/**
 * Mutating an entity whose partition this client no longer holds.
 *
 * A principal replacement, a read-view reset or a close withdraws every handle
 * that partition produced. The handle keeps saying what the entity was — a
 * rendered list must not turn into holes — but its target means nothing in the
 * partition that replaced it, so the call is refused here rather than queued
 * against a receiver that never held it.
 */
export class EntityWithdrawnError extends Data.TaggedError(
  "EntityWithdrawnError",
)<{ readonly operation: string }> {}

/** One entity, as an application holds it. */
export interface EntityHandle<
  Data = unknown,
  Mutations = MutationNamespace,
  Entity extends AnyEntity = AnyEntity,
> {
  readonly id: MutationRef<Entity>;
  readonly data: Data;
  readonly local: EntityLocal;
  readonly mutate: Mutations;
}

export class EntityRegistry {
  private readonly handles = new Map<string, LiveHandle>();
  private readonly aliases = new Map<string, MutationRef>();
  private readonly reverse = new Map<MutationRef, readonly ClientRef[]>();
  private readonly views = new Map<string, readonly string[]>();
  private pending: OptimisticPending = new Map();

  constructor(
    private readonly context: MutationContext,
    private readonly database: ClientDatabase,
    private readonly operations: (focus: AnyComposer) => ReadonlyMap<string, ClientOperation>,
  ) {}

  observe(pending: OptimisticPending): ReadonlySet<EntityHandle> {
    this.pending = pending;
    const moved = new Set<EntityHandle>();
    for (const handle of this.handles.values()) {
      if (handle.apply(this.stateFor(handle.id))) moved.add(handle);
    }
    return moved;
  }

  alias(ref: ClientRef, id: MutationRef): void {
    if (this.aliases.get(ref) === id) return;
    this.aliases.set(ref, id);
    this.reverse.set(id, [...(this.reverse.get(id) ?? []), ref]);
    const views = this.views.get(ref) ?? [];
    for (const view of views) {
      const existing = this.handles.get(`${view}\u0000${ref}`);
      if (existing === undefined) continue;
      existing.rename(id);
      this.handles.set(`${view}\u0000${id}`, existing);
    }
    this.views.set(id, [...(this.views.get(id) ?? []), ...views]);
  }

  handle(
    id: MutationRef,
    focus: AnyComposer,
    shape: string,
    data: unknown,
  ): EntityHandle {
    const identity = this.aliases.get(id) ?? id;
    const view = `${focus._tag}:${focus.ns}\u0000${shape}`;
    const key = `${view}\u0000${identity}`;
    const existing = this.handles.get(key);
    if (existing !== undefined) {
      existing.update(data);
      return existing;
    }
    const handle = new LiveHandle(
      identity,
      data,
      mutationNamespace(
        this.context,
        this.database,
        this.operations(focus),
        identity,
      ),
    );
    handle.apply(this.stateFor(identity));
    this.handles.set(key, handle);
    this.views.set(identity, [...(this.views.get(identity) ?? []), view]);
    return handle;
  }

  private stateFor(identity: MutationRef): EntityLocal {
    for (const name of [identity, ...(this.reverse.get(identity) ?? [])]) {
      const entry = this.pending.get(name);
      if (entry !== undefined) {
        return Object.freeze({ pending: true, created: entry.created });
      }
    }
    return SETTLED;
  }

  clear(): void {
    for (const handle of this.handles.values()) handle.withdraw();
    this.handles.clear();
    this.aliases.clear();
    this.reverse.clear();
    this.views.clear();
    this.pending = new Map();
  }
}

class LiveHandle implements EntityHandle {
  #id: MutationRef;
  #data: unknown;
  #local: EntityLocal = SETTLED;
  #withdrawn = false;
  readonly mutate: MutationNamespace;

  constructor(id: MutationRef, data: unknown, live: MutationNamespace) {
    this.#id = id;
    this.#data = data;
    const methods: Record<string, MutationMethod> = {};
    for (const [name, method] of Object.entries(live)) {
      methods[name] = (input?: unknown) => {
        if (this.#withdrawn) {
          throw new EntityWithdrawnError({ operation: name });
        }
        return method(input);
      };
    }
    this.mutate = Object.freeze(methods);
  }

  get id(): MutationRef {
    return this.#id;
  }

  get data(): unknown {
    return this.#data;
  }

  get local(): EntityLocal {
    return this.#local;
  }

  update(data: unknown): void {
    this.#data = data;
  }

  rename(id: MutationRef): void {
    this.#id = id;
  }

  apply(next: EntityLocal): boolean {
    if (
      next.pending === this.#local.pending && next.created === this.#local.created
    ) return false;
    this.#local = next;
    return true;
  }

  withdraw(): void {
    this.#withdrawn = true;
    this.#local = SETTLED;
  }
}

export const rowIdentity = (row: unknown): MutationRef | undefined => {
  if (row === null || typeof row !== "object") return undefined;
  const id = (row as { readonly id?: unknown }).id;
  return typeof id === "string" ? (id as MutationRef) : undefined;
};

export const isLocalIdentity = (id: MutationRef): id is ClientRef =>
  isClientRef(id);
