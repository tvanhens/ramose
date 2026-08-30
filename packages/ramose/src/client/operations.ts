
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type { CatalogDefinition } from "../Catalog.ts";
import type { AllocationSlots } from "../db/allocations.ts";
import { reachableTraits, type ComposerLike } from "../db/compose.ts";
import {
  isOwnedOperation,
  OwnedOperations,
  type AnyOwnedOperation,
} from "../db/Operation.ts";
import type { AnySchema } from "../db/Schema.ts";
import {
  normalizeProjectionRevision,
  type AnyOptimisticProjection,
} from "../db/Projection.ts";
import {
  snapshotOwnedOperations,
  type OwnedOperationSnapshot,
} from "../internal/authorization/authoring/operations.ts";
import type { OperationInputShape } from "../internal/authorization/catalog.ts";
import {
  CatalogId,
  DigestHex,
  type OperationVersion,
  type OwnerRef,
} from "../internal/authorization/identities.ts";
import { hashOperationVersion } from "../internal/authorization/operation-version.ts";
import type { CompositionIndex } from "../internal/core/composition.ts";
import type { InstalledProjection } from "../internal/replication/projection-binding.ts";

const NO_ARTIFACT = DigestHex.make("0".repeat(64));

/** One deployed operation, as a client may invoke it. */
export type ClientOperation = {
  readonly owner: OwnerRef;
  readonly localName: string;
  readonly self: boolean;
  readonly version: () => Promise<OperationVersion>;
  readonly allocations: AllocationSlots;
  readonly composers: readonly string[];
  readonly input: OperationInputShape;
  readonly encode: (input: unknown) => unknown;
  readonly optimistic:
    | { readonly revision: number; readonly run: AnyOptimisticProjection }
    | undefined;
};

/** Every deployed operation, indexed the two ways the public surface reaches them. */
export type ClientOperations = {
  readonly catalog: CatalogId;
  readonly database: ReadonlyMap<string, ClientOperation>;
  readonly self: ReadonlyMap<string, ReadonlyMap<string, ClientOperation>>;
  readonly installed: readonly InstalledProjection[];
};

const ownerKey = (owner: OwnerRef): string => `${owner.kind}\u0000${owner.name}`;

const invalid = (detail: string): never => {
  throw new Error(`ramose/client: ${detail}`);
};

const authoredOperations = (
  schema: AnySchema,
): ReadonlyMap<string, AnyOwnedOperation> => {
  const entities = Object.values(schema.entities);
  const owners: readonly { readonly kind: "entity" | "trait"; readonly owner: unknown }[] = [
    ...entities.map((entity) => ({ kind: "entity" as const, owner: entity })),
    ...[...reachableTraits(entities as unknown as Iterable<ComposerLike>).values()]
      .map((trait) => ({ kind: "trait" as const, owner: trait })),
  ];
  const authored = new Map<string, AnyOwnedOperation>();
  for (const { kind, owner } of owners) {
    const declared =
      (owner as { readonly [OwnedOperations]?: Readonly<Record<string, unknown>> })[
        OwnedOperations
      ] ?? {};
    for (const [localName, candidate] of Object.entries(declared)) {
      if (!isOwnedOperation(candidate)) continue;
      const name = (owner as { readonly ns: string }).ns;
      authored.set(`${kind} ${name} ${localName}`, candidate);
    }
  }
  return authored;
};

const clientOperation = (
  snapshot: OwnedOperationSnapshot,
  authored: ReadonlyMap<string, AnyOwnedOperation>,
): ClientOperation => {
  const declaration = authored.get(
    `${snapshot.owner.kind} ${snapshot.owner.name} ${snapshot.localName}`,
  );
  const projection = declaration?.optimistic;
  let version: Promise<OperationVersion> | undefined;
  return {
    owner: snapshot.owner,
    localName: snapshot.localName,
    self: snapshot.self,
    version: () => {
      version ??= Effect.runPromise(
        hashOperationVersion(snapshot.versionDescriptor),
      );
      return version;
    },
    allocations: snapshot.versionDescriptor.allocations,
    composers: snapshot.composers.map((entity) => entity.name),
    input: snapshot.inputShape,
    encode: (input) => snapshot.inputCodec.encode(input),
    optimistic: projection === undefined ? undefined : {
      revision: normalizeProjectionRevision(declaration?.optimisticRevision),
      run: projection,
    },
  };
};

/** Lower the installed catalog's operations, synchronously. */
export const installClientOperations = (
  definition: CatalogDefinition,
  schema: AnySchema,
): ClientOperations => {
  const catalog = CatalogId.make(definition.key);
  const lowered = snapshotOwnedOperations(catalog, [schema], NO_ARTIFACT);
  if (Result.isFailure(lowered)) {
    invalid(`catalog operations could not be lowered: ${lowered.failure.message}`);
  }
  const authored = authoredOperations(schema);
  const operations =
    (lowered as Result.Success<readonly OwnedOperationSnapshot[], never>).success
      .map((snapshot) => clientOperation(snapshot, authored));

  const database = new Map<string, ClientOperation>();
  const self = new Map<string, Map<string, ClientOperation>>();
  const installed: InstalledProjection[] = [];
  for (const operation of operations) {
    installed.push({
      operation: {
        catalog,
        owner: operation.owner,
        localName: operation.localName,
      },
      projection: operation.optimistic,
    });
    if (!operation.self) {
      if (database.has(operation.localName)) {
        invalid(
          `two catalog operations answer to db.mutate.${operation.localName}`,
        );
      }
      database.set(operation.localName, operation);
      continue;
    }
    const key = ownerKey(operation.owner);
    const owned = self.get(key) ?? new Map<string, ClientOperation>();
    owned.set(operation.localName, operation);
    self.set(key, owned);
  }
  return Object.freeze({
    catalog,
    database,
    self,
    installed: Object.freeze(installed),
  });
};

/** The self and trait operations one declared focus reaches. */
export const selfOperationsFor = (
  operations: ClientOperations,
  composition: CompositionIndex,
  typeName: string,
): ReadonlyMap<string, ClientOperation> => {
  const owners: OwnerRef[] = [{ kind: "entity", name: typeName }];
  for (const trait of composition.transitiveTraits(`:${typeName}`)) {
    owners.push({ kind: "trait", name: trait.startsWith(":") ? trait.slice(1) : trait });
  }
  const methods = new Map<string, ClientOperation>();
  for (const owner of owners) {
    for (const [name, operation] of operations.self.get(ownerKey(owner)) ?? []) {
      const existing = methods.get(name);
      if (existing !== undefined) {
        invalid(
          `${typeName}.mutate.${name} is declared by both ${existing.owner.kind} ` +
            `'${existing.owner.name}' and ${owner.kind} '${owner.name}'`,
        );
      }
      methods.set(name, operation);
    }
  }
  return methods;
};
