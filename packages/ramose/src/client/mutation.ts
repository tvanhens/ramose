
import { clientRef, invocationId, type ClientRef, type MutationRef } from "../db/refs.ts";
import { inputEntityRefHandles } from "../internal/authorization/entity-targets.ts";
import type { JsonValue } from "../internal/authorization/json.ts";
import type { IndexedDbReplicaStorage } from "../internal/replication/indexeddb.ts";
import type { OutboxDraft, QueuedTarget } from "../internal/replication/outbox.ts";
import { projectionIdentity } from "../internal/replication/projection-binding.ts";
import type { ReplicaDatabaseScope } from "../internal/replication/replica-lifecycle.ts";
import type { ClientCatalog } from "./catalog.ts";
import { resolveGraphReceiver } from "./graph.ts";
import type { ClientDatabase } from "./database.ts";
import type { ClientOperation } from "./operations.ts";
import { ReceiptDriver, type Receipt } from "./receipt.ts";

/** Everything one mutation call needs from the client that owns it. */
export type MutationContext = {
  readonly databaseOperations: () => ReadonlyMap<string, ClientOperation>;
  readonly catalog: () => Promise<ClientCatalog>;
  readonly storage: () => Promise<IndexedDbReplicaStorage>;
  readonly assertLive: (operation: string) => void;
  readonly submit: (receiver: ReplicaDatabaseScope) => void;
  readonly track: (
    receiver: ReplicaDatabaseScope,
    driver: ReceiptDriver,
  ) => void;
};

/** One callable mutation method, as an application sees it. */
export type MutationMethod = (input?: unknown) => Receipt;

/** A catalog-derived namespace: one method per operation the surface reaches. */
export type MutationNamespace = Readonly<Record<string, MutationMethod>>;

const queuedTarget = (target: MutationRef | undefined): QueuedTarget => {
  if (target === undefined) return { type: "none" };
  return target.startsWith("cr1_")
    ? { type: "client-ref", clientRef: target as ClientRef }
    : { type: "entity", entityId: target as never };
};

const allocationsFor = (
  operation: ClientOperation,
): readonly { readonly slot: string; readonly clientRef: ClientRef }[] =>
  operation.allocations.map((slot) => ({
    slot: slot.slot,
    clientRef: clientRef(),
  }));

const enqueue = async (
  context: MutationContext,
  database: ClientDatabase,
  operation: ClientOperation,
  target: MutationRef | undefined,
  input: unknown,
  driver: ReceiptDriver,
): Promise<void> => {
  const receiver = await resolveGraphReceiver(database);
  const [catalog, storage] = await Promise.all([
    context.catalog(),
    context.storage(),
  ]);
  const [encoded, version] = [
    operation.encode(input) as JsonValue,
    await operation.version(),
  ];
  const allocations = allocationsFor(operation);
  const draft: OutboxDraft = {
    invocation: driver.receipt.invocation,
    receiver,
    operation: {
      catalog: catalog.key as never,
      owner: operation.owner,
      localName: operation.localName,
    },
    operationVersion: version,
    target: queuedTarget(target),
    input: encoded,
    allocations,
    inputRefs: inputEntityRefHandles(operation.input, encoded).flatMap((path) => {
      const ref = path.reduce<unknown>(
        (value, segment) => (value as Record<string, unknown>)[segment as string],
        encoded,
      );
      return typeof ref === "string" ? [{ path, ref: ref as MutationRef }] : [];
    }),
    enqueuedAt: Date.now(),
  };
  context.track(receiver, driver);
  await storage.outbox().enqueue(draft, {
    scope: { server: receiver.server, principal: receiver.principal },
    ...(operation.optimistic === undefined ? {} : {
      projection: projectionIdentity(
        catalog.projections.build,
        operation.optimistic.revision,
      ),
    }),
  });
  driver.queue();
  context.submit(receiver);
};

/** One callable method per operation, each returning a durable receipt. */
export const mutationNamespace = (
  context: MutationContext,
  database: ClientDatabase,
  operations: ReadonlyMap<string, ClientOperation>,
  target?: MutationRef,
): MutationNamespace => {
  const methods: Record<string, MutationMethod> = {};
  for (const [name, operation] of operations) {
    methods[name] = (input?: unknown): Receipt => {
      context.assertLive(`mutate.${name}`);
      const driver = new ReceiptDriver(invocationId());
      void enqueue(context, database, operation, target, input, driver)
        .catch((cause: unknown) => {
          driver.fail(cause instanceof Error ? cause : new Error(String(cause)));
        });
      return driver.receipt;
    };
  }
  return Object.freeze(methods);
};
