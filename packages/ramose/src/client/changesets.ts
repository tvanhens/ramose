import { Store, sameResult, type Subscription } from "./subscription.ts";
import type { QuerySnapshot } from "./database.ts";
import type { AnyComposer } from "../db/Composer.ts";
import { OwnedOperations } from "../db/Operation.ts";
import type { MutationRef } from "../db/refs.ts";
import type { MutationInput } from "./mutation-schema.ts";
import { DatabaseView } from "./view.ts";
import { decodeChangesetList, decodeChangesetResponse, decodeReadResponse, type ChangesetResponse } from "../internal/changesets/protocol.ts";
import type { ClientOperation, ClientOperations } from "./operations.ts";

const PreparedOperation: unique symbol = Symbol("ramose/prepared-operation");
export type ChangesetOperation = { readonly [PreparedOperation]: {
  readonly owner: { readonly kind: "entity" | "trait"; readonly name: string };
  readonly name: string;
  readonly input: unknown;
  readonly target?: string;
} };

type OperationsOf<N> = N extends { readonly [OwnedOperations]: infer O } ? O : never;
type InputOf<O> = O extends { readonly input: infer I } ? MutationInput<I> : never;
export type ProposalOperations<N extends AnyComposer> = {
  readonly [K in keyof OperationsOf<N>]: OperationsOf<N>[K] extends { readonly self: false }
    ? (input: InputOf<OperationsOf<N>[K]>) => ChangesetOperation
    : (target: MutationRef, input: InputOf<OperationsOf<N>[K]>) => ChangesetOperation;
};

export type ChangesetChange = {
  readonly entity: string;
  readonly field: string;
  readonly value: unknown;
  readonly added: boolean;
};

export type Changeset = ChangesetResponse;

export type ChangesetProposal = {
  readonly id: string;
  readonly revision?: string;
  readonly title: string;
  readonly reviewers?: readonly string[];
  readonly operations: readonly ChangesetOperation[];
};

export type ChangesetPage = { readonly items: readonly Changeset[]; readonly nextCursor: string | null; readonly version: string };
export type ChangesetListOptions = { readonly after?: string; readonly limit?: number };
export type ClientChangesets = {
  readonly list: (options?: ChangesetListOptions) => Promise<ChangesetPage>;
  readonly observe: (options?: ChangesetListOptions & { readonly id?: string }) => Subscription<QuerySnapshot<ChangesetPage>>;
  readonly operations: <N extends AnyComposer>(owner: N) => ProposalOperations<N>;
  readonly open: (id: string, revision: string) => DatabaseView;
  readonly append: (id: string, revision: string, operations: readonly ChangesetOperation[]) => Promise<Changeset>;
  readonly prepare: (proposal: ChangesetProposal) => Promise<Changeset>;
  readonly inspect: (id: string) => Promise<Changeset>;
  readonly commit: (id: string, revision: string) => Promise<Changeset>;
  readonly discard: (id: string, revision: string) => Promise<Changeset>;
};

export class ChangesetError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
    this.name = "ChangesetError";
  }
}

export const clientChangesets = (context: {
  readonly signal: AbortSignal;
  readonly endpoint: string;
  readonly credential: () => Promise<{ readonly token: string }>;
  readonly operations: () => ClientOperations;
  readonly assertLive: () => void;
  readonly subscribe: (changed: () => void) => () => void;
}): ClientChangesets => {
  const request = async (body: unknown, signal?: AbortSignal): Promise<unknown> => {
    context.assertLive();
    const credential = await context.credential();
    const response = await fetch(context.endpoint, {
      method: "POST",
      signal: signal === undefined ? context.signal : AbortSignal.any([signal, context.signal]),
      headers: { "content-type": "application/json", authorization: `Bearer ${credential.token}` },
      body: JSON.stringify(body),
    });
    const result: unknown = await response.json();
    context.assertLive();
    if (!response.ok) {
      const code = typeof result === "object" && result !== null && "code" in result && typeof result.code === "string" ? result.code : "changeset_failed";
      throw new ChangesetError(code, response.status);
    }
    return result;
  };
  const encode = async (steps: readonly ChangesetOperation[]) => {
    const registry = context.operations();
    return Promise.all(steps.map(async (prepared) => {
      const step = prepared[PreparedOperation];
      const operation: ClientOperation | undefined = step.target === undefined
        ? registry.database.get(step.name)
        : registry.self.get(`${step.owner.kind}\0${step.owner.name}`)?.get(step.name);
      if (operation === undefined || operation.owner.kind !== step.owner.kind || operation.owner.name !== step.owner.name) {
        throw new ChangesetError("unknown_operation", 400);
      }
      return {
        operation: { owner: step.owner, localName: step.name },
        operationVersion: await operation.version(),
        input: operation.encode(step.input),
        ...(step.target === undefined ? {} : { target: step.target }),
      };
    }));
  };
  const views = new Map<string, WeakRef<DatabaseView>>();
  const activeObservers = new Map<string, Subscription<QuerySnapshot<ChangesetPage>>>();
  const observers = new Map<string, WeakRef<Subscription<QuerySnapshot<ChangesetPage>>>>();
  const observe = (options: ChangesetListOptions & { readonly id?: string } = {}): Subscription<QuerySnapshot<ChangesetPage>> => {
    const key = JSON.stringify([options.id, options.after, options.limit]);
    const existing = activeObservers.get(key) ?? observers.get(key)?.deref();
    if (existing !== undefined) return existing;
    const store = new Store<QuerySnapshot<ChangesetPage>>({ status: "pending", data: undefined, stale: true, error: undefined });
    let watching: AbortController | undefined;
    const stopWatching = () => { watching?.abort(); watching = undefined; activeObservers.delete(key); context.signal.removeEventListener("abort", stopWatching); };
    const subscription: Subscription<QuerySnapshot<ChangesetPage>> = {
      getSnapshot: () => store.getSnapshot(),
      subscribe: (changed) => {
        context.assertLive();
        const stop = store.subscribe(changed);
        activeObservers.set(key, subscription);
        if (watching === undefined) {
          const controller = new AbortController();
          watching = controller;
          context.signal.addEventListener("abort", stopWatching, { once: true });
          void (async () => {
            let version: string | undefined;
            while (!controller.signal.aborted && !context.signal.aborted) {
              try {
                const response = decodeChangesetList(await request({ action: "watch", ...options, version }, controller.signal));
                if (controller.signal.aborted || context.signal.aborted) break;
                version = response.version;
                if (!sameResult(store.getSnapshot().data, response) || store.getSnapshot().status !== "ready")
                  store.publish({ status: "ready", data: response, stale: false, error: undefined });
              } catch (cause) {
                if (controller.signal.aborted || context.signal.aborted) break;
                store.publish({ status: "error", data: undefined, stale: true, error: cause instanceof Error ? cause : new Error("proposal subscription failed") });
                await new Promise<void>((resolve) => {
                  const done = () => { clearTimeout(timer); controller.signal.removeEventListener("abort", done); resolve(); };
                  const timer = setTimeout(done, 2000);
                  controller.signal.addEventListener("abort", done, { once: true });
                });
              }
            }
          })();
        }
        return () => { stop(); if (store.size === 0) stopWatching(); };
      },
    };
    for (const [cached, value] of observers) if (value.deref() === undefined) observers.delete(cached);
    if (observers.size >= 128) observers.delete(observers.keys().next().value!);
    observers.set(key, new WeakRef(subscription));
    return subscription;
  };
  context.signal.addEventListener("abort", () => { views.clear(); observers.clear(); activeObservers.clear(); }, { once: true });
  const proposal = async (body: unknown) => decodeChangesetResponse(await request(body));
  return {
    observe,
    list: async (options = {}) => decodeChangesetList(await request({ action: "list", ...options })),
    operations: <N extends AnyComposer>(owner: N): ProposalOperations<N> => {
      const registry = context.operations();
      const kind = owner._tag === "Trait" ? "trait" : "entity";
      const operations = [...registry.database.values(), ...registry.self.get(`${kind}\0${owner.ns}`)?.values() ?? []]
        .filter((operation) => operation.owner.kind === kind && operation.owner.name === owner.ns);
      return Object.freeze(Object.fromEntries(operations.map((operation) => [operation.localName,
        (...args: readonly unknown[]) => Object.freeze({ [PreparedOperation]: {
          owner: operation.owner, name: operation.localName,
          input: operation.self ? args[1] : args[0],
          ...(operation.self ? { target: args[0] as string } : {}),
        } }),
      ]))) as ProposalOperations<N>;
    },
    open: (id, revision) => {
      const key = `${id}\0${revision}`;
      let view = views.get(key)?.deref();
      if (view === undefined) { view = new DatabaseView({
        read: async (query, signal) => {
          const response = decodeReadResponse(await request({ action: "read", id, revision, query }, signal));
          if (response.revision !== revision) throw new ChangesetError("changeset_revision_conflict", 409);
          return response;
        },
        subscribe: (changed) => {
          const stopProposal = observe({ id }).subscribe(changed);
          const stopDatabase = context.subscribe(changed);
          return () => { stopProposal(); stopDatabase(); };
        }, assertLive: context.assertLive,
      }); for (const [cached, value] of views) if (value.deref() === undefined) views.delete(cached);
        if (views.size >= 128) views.delete(views.keys().next().value!);
        views.set(key, new WeakRef(view)); }
      return view;
    },
    append: async (id, revision, steps) => proposal({ action: "append", id, revision, operations: await encode(steps) }),
    prepare: async (input) => proposal({ ...input, action: "prepare", operations: await encode(input.operations) }),
    inspect: (id) => proposal({ action: "inspect", id }),
    commit: (id, revision) => proposal({ action: "commit", id, revision }),
    discard: (id, revision) => proposal({ action: "discard", id, revision }),
  };
};
