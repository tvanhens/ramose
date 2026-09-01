import { type AnyComposer } from "../db/Composer.ts";
import type { AnyEntity } from "../db/Entity.ts";
import type { Eid } from "../db/Eid.ts";
import type { MutationRef } from "../db/refs.ts";
import type { EntityRow, FluentQuery, WhereEq } from "../db/query/fluent.ts";
import type { FocusAttr } from "../db/query/focus.ts";
import type { IdRow } from "../db/query/lib.ts";
import {
  from as queryFrom,
  type Cursor,
  type Page,
  type Pipeline,
  type QueryObject,
  type QueryOrderKey,
} from "../db/query/index.ts";
import type { OrderDir, OrderEmpty } from "../db/shapes.ts";
import { replicaDatabaseScopeOf, type ReplicaDatabaseScope } from "../internal/replication/replica-lifecycle.ts";
import type { EntityHandle } from "./entity.ts";
import { DatabaseReceiverError } from "./errors.ts";
import type { EntityMutations } from "./mutation-schema.ts";
import type { ClientDatabase, ClientDatabaseHandle } from "./database.ts";
import type { Subscription } from "./subscription.ts";
import type { SyncStatus } from "./sync.ts";

declare const EntityFocusBrand: unique symbol;

export type EntityFocused<N extends AnyComposer, Row, Out> =
  & QueryObject<Row, Out>
  & { readonly [EntityFocusBrand]: N };

export type EntityResult<N extends AnyComposer, Row, Out> = EntityResultOf<
  EntityHandle<
    ClientValue<Row>,
    EntityMutations<N>,
    [N] extends [AnyEntity] ? N : AnyEntity
  >,
  Out
>;

type EntityResultOf<Handle, Out> = [Out] extends [readonly unknown[]]
  ? readonly Handle[]
  : [Out] extends [{ readonly rows: readonly unknown[] }]
    ? Omit<Out, "rows"> & { readonly rows: readonly Handle[] }
  : null extends Out ? Handle | null
  : Handle;

export interface ClientQuery<
  N extends AnyComposer,
  Row = EntityRow<N>,
  Out = readonly Row[],
> extends FluentQuery<N, Row, Out> {
  readonly [EntityFocusBrand]: N;

  where<const W extends WhereEq<N>>(eq: W): ClientQuery<N, Row, Out>;
  where(
    ...stages: ReadonlyArray<(q: Pipeline<Row, N>) => Pipeline<Row, N>>
  ): ClientQuery<N, Row, Out>;
  orderBy(
    key: QueryOrderKey<Row> | FocusAttr<N>,
    dir?: OrderDir,
    opts?: { readonly empty?: OrderEmpty },
  ): ClientQuery<N, Row, Out>;
  limit(n: number): ClientQuery<N, Row, Out>;
  offset(n: number): ClientQuery<N, Row, Out>;
  after(cursor: Cursor | null): EntityFocused<N, Row, Page<Row>>;
  ids(): ClientQuery<N, IdRow<N>>;
  one(): EntityFocused<N, Row, Row | null>;
  oneOrFail(): EntityFocused<N, Row, Row>;
}

export type ClientValue<A> = A extends Eid<infer E extends AnyEntity>
  ? MutationRef<E>
  : A extends Date | Uint8Array ? A
  : A extends readonly (infer Item)[] ? readonly ClientValue<Item>[]
  : A extends object ? {
      readonly [K in keyof A]: K extends ":db/id"
        ? MutationRef | Extract<A[K], undefined>
        : ClientValue<A[K]>;
    }
  : A;

type AnyFluent = FluentQuery<AnyComposer, unknown, unknown>;
const CHAIN = ["where", "orderBy", "limit", "offset", "ids", "after"] as const;

export const ENTITY_FOCUS = Symbol.for("ramose/client/entity-focus") as symbol;

export const entityFocusOf = (query: unknown): AnyComposer | undefined => {
  if (query === null || typeof query !== "object") return undefined;
  const focus = (query as Record<symbol, unknown>)[ENTITY_FOCUS];
  return focus === undefined ? undefined : (focus as AnyComposer);
};

const decorate = (
  fluent: AnyFluent,
  ns: AnyComposer,
): AnyFluent => {
  const wrapped = { ...fluent } as unknown as Record<string | symbol, unknown>;
  wrapped[ENTITY_FOCUS] = ns;
  for (const key of CHAIN) {
    const method = (fluent as unknown as Record<string, unknown>)[key];
    if (typeof method !== "function") continue;
    wrapped[key] = (...args: unknown[]): AnyFluent =>
      decorate((method as (...a: unknown[]) => AnyFluent).apply(fluent, args), ns);
  }
  for (const key of ["one", "oneOrFail"] as const) {
    wrapped[key] = (): unknown => Object.assign(
      { [ENTITY_FOCUS]: ns },
      (fluent as unknown as Record<string, () => unknown>)[key]!.call(fluent),
    );
  }
  return wrapped as unknown as AnyFluent;
};

export const clientQueryFrom = <N extends AnyComposer>(entity: N): ClientQuery<N> => {
  const base = queryFrom(entity) as unknown as AnyFluent;
  return decorate(base, entity) as unknown as ClientQuery<N>;
};

const settleOn = <A>(
  source: Subscription<unknown>,
  attempt: (
    resolve: (value: A) => void,
    reject: (error: unknown) => void,
  ) => boolean,
): Promise<A> =>
  new Promise<A>((resolve, reject) => {
    let stop: (() => void) | undefined;
    let done = false;
    const settle = (): void => {
      if (done) return;
      done = attempt(resolve, reject);
      if (done) stop?.();
    };
    settle();
    if (done) return;
    stop = source.subscribe(settle);
    if (done) stop();
  });

export const fencedReceiver = (
  status: SyncStatus,
): DatabaseReceiverError | undefined => {
  switch (status) {
    case "authentication-required":
      return new DatabaseReceiverError({
        reason: "unauthorized",
        message: "this database's credential no longer opens it",
      });
    case "update-required":
      return new DatabaseReceiverError({
        reason: "update-required",
        message: "this build cannot read or replay against this database",
      });
    case "closed":
      return new DatabaseReceiverError({
        reason: "closed",
        message: "this database was closed before its receiver was known",
      });
    default:
      return undefined;
  }
};

export const resolveDatabaseReceiver = (
  database: ClientDatabase,
): Promise<ReplicaDatabaseScope> => {
  const handle = database as ClientDatabaseHandle;
  void handle.activate();
  return settleOn(handle.sync, (resolve, reject) => {
    const fenced = fencedReceiver(handle.syncStatus());
    if (fenced !== undefined) {
      reject(fenced);
      return true;
    }
    const identity = handle.confirmedIdentity();
    if (identity === undefined) return false;
    resolve(replicaDatabaseScopeOf(identity));
    return true;
  });
};
