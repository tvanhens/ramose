/** Concrete database bindings for atomic installed catalog definitions. */

import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { Unauthorized } from "../../db/Errors.ts";
import type { CompiledCreationPlan } from "../../db/creation.ts";
import type { CreationDefaultContext } from "../../db/Field.ts";
import type { CompositionIndex } from "../core/composition.ts";
import type { InstalledCatalogUnitV2 } from "./catalog-unit.ts";
import type {
  InstalledCatalogDefinition,
  InstalledOperationDefinition,
} from "./definitions.ts";
import {
  CatalogMismatch,
  CatalogVersionMismatch,
  InvalidIR,
} from "./failures.ts";
import type {
  CatalogId,
  CatalogUnitHash,
  DatabaseId,
  OperationId,
} from "./identities.ts";

export type CatalogBoundRef = {
  readonly database: DatabaseId;
  readonly catalogKey: CatalogId;
  readonly unitHash: CatalogUnitHash;
};

/** Inseparable inert descriptor and original trusted deployed executable. */
export type DeployedOperation = InstalledOperationDefinition;

export type DeployedCatalog = {
  readonly database: DatabaseId;
  readonly catalogKey: CatalogId;
  readonly unitHash: CatalogUnitHash;
  readonly unit: InstalledCatalogUnitV2;
  readonly composition: CompositionIndex;
  readonly operations: ReadonlyMap<string, DeployedOperation>;
  readonly creationPlans: readonly CompiledCreationPlan[];
  readonly resolveCreationValues: (
    entityName: string,
    input: Readonly<Record<string, unknown>>,
    context: CreationDefaultContext,
  ) => Readonly<Record<string, unknown>>;
};

export type DeployedCatalogs = {
  readonly requireDatabase: (
    database: DatabaseId,
  ) => Result.Result<DeployedCatalog, CatalogMismatch>;
  readonly databases: () => readonly DatabaseId[];
};

/** One concrete database address bound to one atomic #471 artifact. */
export type CatalogAssemblyUnit = {
  readonly database: DatabaseId;
  readonly definition: InstalledCatalogDefinition;
};

export type CatalogAssemblyInput = {
  readonly units: readonly CatalogAssemblyUnit[];
};

const compareDatabaseId = (left: DatabaseId, right: DatabaseId): number =>
  left < right ? -1 : left > right ? 1 : 0;

export const deployedOperationKey = (id: OperationId): string =>
  `${id.catalog}\0${id.owner.kind}\0${id.owner.name}\0${id.localName}\0${id.target}`;

const sameEntityIds = (
  left: InstalledOperationDefinition["writes"],
  right: InstalledOperationDefinition["descriptor"]["writes"],
): boolean => left.length === right.length && left.every((entity, index) => {
  const expected = right[index];
  return expected !== undefined &&
    entity.catalog === expected.catalog &&
    entity.name === expected.name;
});

const bindOperations = (
  definition: InstalledCatalogDefinition,
): ReadonlyMap<string, DeployedOperation> => {
  const operations = new Map<string, DeployedOperation>();
  const sealed = new Map(
    definition.unit.catalog.operations.map((descriptor) => [
      deployedOperationKey(descriptor.id),
      descriptor,
    ] as const),
  );
  if (sealed.size !== definition.unit.catalog.operations.length) {
    throw new InvalidIR({ message: "duplicate sealed operation identity" });
  }
  for (const installed of definition.operations) {
    const key = deployedOperationKey(installed.id);
    if (operations.has(key)) {
      throw new InvalidIR({
        message: `duplicate installed operation '${installed.localName}'`,
      });
    }
    const descriptor = sealed.get(key);
    if (
      descriptor === undefined ||
      installed.descriptor !== descriptor ||
      deployedOperationKey(installed.descriptor.id) !== key ||
      installed.owner.kind !== descriptor.id.owner.kind ||
      installed.owner.name !== descriptor.id.owner.name ||
      installed.localName !== descriptor.id.localName ||
      installed.self !== (descriptor.id.target === "required") ||
      !sameEntityIds(installed.writes, descriptor.writes) ||
      installed.descriptor.bodyHash !== descriptor.bodyHash ||
      installed.descriptor.inputSchemaHash !== descriptor.inputSchemaHash ||
      installed.descriptor.outputSchemaHash !== descriptor.outputSchemaHash ||
      installed.implementationHash !== descriptor.bodyHash ||
      typeof installed.run !== "function"
    ) {
      throw new InvalidIR({
        message: `mismatched installed operation '${installed.localName}'`,
      });
    }
    operations.set(key, installed);
  }
  if (operations.size !== sealed.size) {
    throw new InvalidIR({ message: "missing installed operation executable" });
  }
  return Object.freeze(operations);
};

const deploy = (
  unit: CatalogAssemblyUnit,
): DeployedCatalog => {
  const definition = unit.definition;
  return Object.freeze({
    database: unit.database,
    catalogKey: definition.catalogKey,
    unitHash: definition.unitHash,
    unit: definition.unit,
    composition: definition.composition,
    operations: bindOperations(definition),
    creationPlans: definition.creationPlans,
    resolveCreationValues: definition.resolveCreationValues,
  });
};

const buildRegistry = (
  byDatabase: ReadonlyMap<DatabaseId, DeployedCatalog>,
): DeployedCatalogs => Object.freeze({
  requireDatabase: (database: DatabaseId) => {
    const deployed = byDatabase.get(database);
    return deployed === undefined
      ? Result.fail(new CatalogMismatch({
          message: "catalog mismatch",
          expectedDatabase: database,
        }))
      : Result.succeed(deployed);
  },
  databases: () => Object.freeze(
    [...byDatabase.keys()].sort(compareDatabaseId),
  ),
});

/** Exact catalog-key agreement with a database-selected unit. Pure Result. */
export const requireCatalogKey = (
  actual: CatalogId,
  expected: CatalogId,
): Result.Result<void, CatalogMismatch> => {
  if (actual === expected) return Result.succeed(undefined);
  return Result.fail(
    new CatalogMismatch({
      message: "catalog mismatch",
      expected,
      actual,
    }),
  );
};

/** Exact unit-hash agreement. Pure Result; no Effect or Context lookup. */
export const requireUnitHash = (
  actual: CatalogUnitHash,
  expected: CatalogUnitHash,
  catalog: CatalogId,
): Result.Result<void, CatalogVersionMismatch> => {
  if (actual === expected) return Result.succeed(undefined);
  return Result.fail(new CatalogVersionMismatch({ catalog, expected, actual }));
};

/** Resolve only after the trusted route database selects the installed unit. */
export const resolveDeployedCatalog = (
  catalogs: DeployedCatalogs,
  ref: CatalogBoundRef,
): Result.Result<DeployedCatalog, CatalogMismatch | CatalogVersionMismatch> =>
  Result.gen(function* () {
    const deployed = yield* catalogs.requireDatabase(ref.database);
    yield* requireCatalogKey(ref.catalogKey, deployed.catalogKey);
    yield* requireUnitHash(ref.unitHash, deployed.unitHash, deployed.catalogKey);
    return deployed;
  });

/** Collapse internal mismatch/missing failures to one opaque denial. */
export const opaqueCatalogDenial = (
  _error: CatalogMismatch | CatalogVersionMismatch,
): Unauthorized => new Unauthorized({});

/** Bind concrete database addresses directly to atomic installed definitions. */
export const assembleDeployedCatalogs = Effect.fn(
  "Authorization.assembleDeployedCatalogs",
)(function* (
  input: CatalogAssemblyInput,
): Effect.fn.Return<DeployedCatalogs, InvalidIR> {
  const byDatabase = new Map<DatabaseId, DeployedCatalog>();
  for (const unit of input.units) {
    const deployed = yield* Effect.try({
      try: () => deploy(unit),
      catch: (cause) => cause instanceof InvalidIR
        ? cause
        : new InvalidIR({
            message: `catalog deployment failed: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
          }),
    });
    const prior = byDatabase.get(deployed.database);
    if (prior === undefined) {
      byDatabase.set(deployed.database, deployed);
      continue;
    }
    if (
      prior.catalogKey !== deployed.catalogKey ||
      prior.unitHash !== deployed.unitHash
    ) {
      return yield* new InvalidIR({
        message: `distinct catalog definitions claim database '${deployed.database}'`,
      });
    }
  }
  return buildRegistry(Object.freeze(byDatabase));
});
