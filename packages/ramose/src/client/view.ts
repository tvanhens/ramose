import { isEntityId, type EntityId } from "../db/refs.ts";
import type { AnyEntity } from "../db/Entity.ts";
import type { AnyComposer } from "../db/Composer.ts";
import { lowerQueryObject, type QueryObject } from "../db/query/index.ts";
import { fromJson, toJson } from "../internal/core/json.ts";
import { queryObservationKey, type QuerySnapshot, type QuerySubscription } from "./database.ts";
import { clientQueryFrom, entityFocusOf, type ClientValue, type EntityFocused } from "./query.ts";
import { Store } from "./subscription.ts";
import { rowIdentity } from "./entity.ts";

export type ViewEntity<Data = unknown, Entity extends AnyEntity = AnyEntity> = { readonly id: EntityId<Entity>; readonly data: Data };
export type ViewResult<Row, Out, N extends AnyComposer = AnyComposer> = Out extends readonly unknown[] ? readonly ViewEntity<ClientValue<Row>, N extends AnyEntity ? N : AnyEntity>[]
  : Out extends { readonly rows: readonly unknown[] } ? Omit<ClientValue<Out>, "rows"> & { readonly rows: readonly ViewEntity<ClientValue<Row>, N extends AnyEntity ? N : AnyEntity>[] }
  : null extends Out ? ViewEntity<ClientValue<Row>, N extends AnyEntity ? N : AnyEntity> | null : ViewEntity<ClientValue<Row>, N extends AnyEntity ? N : AnyEntity>;

export class DatabaseView {
  readonly query = { from: clientQueryFrom };
  private readonly observations = new Map<string, { readonly store: Store<QuerySnapshot<unknown>>; readonly run: () => Promise<void>; readonly cancel: () => void }>();

  constructor(private readonly source: {
    readonly read: (query: unknown, signal?: AbortSignal) => Promise<{ readonly result: unknown; readonly entities: readonly string[] }>;
    readonly subscribe: (changed: () => void) => () => void;
    readonly assertLive: () => void;
  }) {}

  async read<N extends AnyComposer, Row, Out>(query: EntityFocused<N, Row, Out>): Promise<ViewResult<Row, Out, N>>;
  async read<Row, Out>(query: QueryObject<Row, Out>): Promise<ClientValue<Out>>;
  async read(query: QueryObject<unknown, unknown>): Promise<unknown> { return this.readQuery(query); }

  private async readQuery(query: QueryObject<unknown, unknown>, signal?: AbortSignal): Promise<unknown> {
    this.source.assertLive();
    let entities: readonly string[] = [];
    const lowered = lowerQueryObject(query, {
      resolveEntity: (id) => ({ $entity: id }),
      entity: (id) => {
        const value = entities[id - 1];
        if (!isEntityId(value)) throw new Error("invalid database view identity");
        return value;
      },
    });
    const response = await this.source.read(toJson(lowered.query), signal);
    entities = response.entities;
    const result = lowered.finalize(fromJson(response.result));
    if (entityFocusOf(query) === undefined) return result;
    const wrap = (data: unknown): unknown => {
      const id = rowIdentity(data);
      if (!isEntityId(id)) throw new Error("database view row has no durable identity");
      return Object.freeze({ id, data });
    };
    if (lowered.result === "row") return result === null ? null : wrap(result);
    if (lowered.result === "page") {
      const page = result as { readonly rows: readonly unknown[] };
      return { ...page, rows: page.rows.map(wrap) };
    }
    return Array.isArray(result) ? result.map(wrap) : result;
  }

  observe<N extends AnyComposer, Row, Out>(query: EntityFocused<N, Row, Out>): QuerySubscription<ViewResult<Row, Out, N>>;
  observe<Row, Out>(query: QueryObject<Row, Out>): QuerySubscription<ClientValue<Out>>;
  observe(query: QueryObject<unknown, unknown>): QuerySubscription<unknown> {
    this.source.assertLive();
    const key = queryObservationKey(query);
    let observation = this.observations.get(key);
    if (observation === undefined) {
      const store = new Store<QuerySnapshot<unknown>>({ status: "pending", data: undefined, stale: true, error: undefined });
      let pending: Promise<void> | undefined;
      let generation = 0;
      let controller: AbortController | undefined;
      const run = (): Promise<void> => {
        generation++;
        const previous = store.getSnapshot();
        if (previous.status === "ready" && !previous.stale) store.publish({ ...previous, stale: true });
        if (pending !== undefined) return pending;
        pending = (async () => {
          while (store.size > 0) {
            const current = generation;
            try {
              controller = new AbortController();
              const data = await this.readQuery(query, controller.signal);
              if (current === generation) store.publish({ status: "ready", data, stale: false, error: undefined });
            } catch (cause) {
              if (current === generation) store.publish({ status: "error", data: undefined, stale: true,
                error: cause instanceof Error ? cause : new Error("database view read failed") });
            }
            if (current === generation) break;
          }
        })().finally(() => { pending = undefined; });
        return pending;
      };
      observation = { store, run, cancel: () => { generation++; controller?.abort(); } };
      if (this.observations.size >= 128) {
        for (const [cached, entry] of this.observations) if (entry.store.size === 0) { this.observations.delete(cached); break; }
      }
      this.observations.set(key, observation);
    }
    const { store, run, cancel } = observation;
    return {
      getSnapshot: () => { this.source.assertLive(); return store.getSnapshot(); },
      subscribe: (changed) => {
        const stop = store.subscribe(changed);
        const stopRevision = this.source.subscribe(() => { void run(); });
        void run();
        return () => { stopRevision(); stop(); if (store.size === 0) { cancel(); if (this.observations.get(key)?.store === store) this.observations.delete(key); } };
      },
    };
  }

  async refresh(): Promise<void> {
    await Promise.all([...this.observations.values()].filter(({ store }) => store.size > 0).map(({ run }) => run()));
  }
}
