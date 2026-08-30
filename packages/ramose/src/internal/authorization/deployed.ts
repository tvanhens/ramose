import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { Unauthorized } from "../../db/Errors.ts";
import type { CatalogDescriptor } from "./catalog.ts";
import type { InstalledCatalogUnitV2 } from "./catalog-unit.ts";
import { compositionFromUnit } from "./composition.ts";
import type { CompositionIndex } from "../core/composition.ts";
import {
  type AssembleCatalogUnitFailure,
  sealInstalledCatalogUnit,
} from "./catalog-unit.ts";
import { CatalogMismatch, CatalogUnitCorrupt, CatalogVersionMismatch, InvalidIR } from "./failures.ts";
import type { CatalogId, CatalogUnitHash, CatalogVersion, DatabaseId } from "./identities.ts";
import { installAuthorization, type InstallFailure } from "./install.ts";
import type { CatalogBindingTarget, PolicyTemplateIR } from "./ir.ts";

export type CatalogBoundRef = {
  readonly database: DatabaseId;
  readonly catalogKey: CatalogId;
  readonly unitHash: CatalogUnitHash;
};

export type DeployedCatalog = {
  readonly database: DatabaseId;
  readonly catalogKey: CatalogId;
  readonly unitHash: CatalogUnitHash;
  readonly unit: InstalledCatalogUnitV2;
  readonly composition: CompositionIndex;
};

export type DeployedCatalogs = {
  readonly requireDatabase: (
    database: DatabaseId,
  ) => Result.Result<DeployedCatalog, CatalogMismatch>;
  readonly databases: () => readonly DatabaseId[];
};

export type CatalogAssemblyUnit = {
  readonly catalog: CatalogId;
  readonly database: DatabaseId;
  readonly version: CatalogVersion;
  readonly children?: readonly CatalogId[];
  readonly descriptor: CatalogDescriptor;
  readonly policy: PolicyTemplateIR;
};

export type CatalogAssemblyInput = {
  readonly root: CatalogId;
  readonly units: readonly CatalogAssemblyUnit[];
};

const freezePlain = <T>(value: T): T => {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) freezePlain(item);
  } else {
    for (const key of Object.keys(value)) {
      freezePlain((value as Record<string, unknown>)[key]);
    }
  }
  return Object.freeze(value);
};

const invalid = (message: string): Result.Result<never, InvalidIR> =>
  Result.fail(new InvalidIR({ message }));

const formatPath = (path: readonly CatalogId[]): string => path.join(" → ");

const compareCatalogId = (left: CatalogId, right: CatalogId): number =>
  left < right ? -1 : left > right ? 1 : 0;

const compareDatabaseId = (left: DatabaseId, right: DatabaseId): number =>
  left < right ? -1 : left > right ? 1 : 0;

const catalogTargetOf = (descriptor: CatalogDescriptor): CatalogBindingTarget => ({
  database: descriptor.database,
  catalog: descriptor.id,
  catalogVersion: descriptor.version,
  schemaFingerprint: descriptor.fingerprint,
});

const assembleOne = Effect.fn("Authorization.assembleOneDeployedCatalog")(
  function* (
    unit: CatalogAssemblyUnit,
  ): Effect.fn.Return<
    DeployedCatalog,
    AssembleCatalogUnitFailure | CatalogUnitCorrupt | InstallFailure | InvalidIR
  > {
    const descriptor = unit.descriptor;
    if (descriptor.id !== unit.catalog) {
      return yield* new InvalidIR({
        message: `catalog '${unit.catalog}' descriptor id '${descriptor.id}' does not match the assembly key`,
      });
    }
    if (descriptor.database !== unit.database) {
      return yield* new InvalidIR({
        message: `catalog '${unit.catalog}' descriptor database does not match the assembly key`,
      });
    }
    if (descriptor.version !== unit.version) {
      return yield* new InvalidIR({
        message: `catalog '${unit.catalog}' descriptor version does not match the assembly key`,
      });
    }
    const policy = yield* installAuthorization({
      target: catalogTargetOf(descriptor),
      descriptor,
      template: unit.policy,
    });
    const sealed = yield* sealInstalledCatalogUnit(descriptor, policy);
    const composition = yield* Effect.fromResult(compositionFromUnit(sealed));
    return freezePlain({
      database: unit.database,
      catalogKey: unit.catalog,
      unitHash: sealed.unitHash,
      unit: sealed,
      composition,
    });
  },
);

const buildRegistry = (
  byDatabase: ReadonlyMap<DatabaseId, DeployedCatalog>,
): DeployedCatalogs => {
  const requireDatabase = (
    database: DatabaseId,
  ): Result.Result<DeployedCatalog, CatalogMismatch> => {
    const deployed = byDatabase.get(database);
    if (deployed === undefined) {
      return Result.fail(
        new CatalogMismatch({
          message: "catalog mismatch",
          expectedDatabase: database,
        }),
      );
    }
    return Result.succeed(deployed);
  };

  const databases = (): readonly DatabaseId[] =>
    Object.freeze([...byDatabase.keys()].sort(compareDatabaseId));

  return Object.freeze({
    requireDatabase,
    databases,
  });
};

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

export const requireUnitHash = (
  actual: CatalogUnitHash,
  expected: CatalogUnitHash,
  catalog: CatalogId,
): Result.Result<void, CatalogVersionMismatch> => {
  if (actual === expected) return Result.succeed(undefined);
  return Result.fail(new CatalogVersionMismatch({ catalog, expected, actual }));
};

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

export const opaqueCatalogDenial = (
  _error: CatalogMismatch | CatalogVersionMismatch,
): Unauthorized => new Unauthorized({});

export const assembleDeployedCatalogs = Effect.fn("Authorization.assembleDeployedCatalogs")(
  function* (
    input: CatalogAssemblyInput,
  ): Effect.fn.Return<
    DeployedCatalogs,
    AssembleCatalogUnitFailure | CatalogUnitCorrupt | InstallFailure | InvalidIR
  > {
    const sources = new Map<CatalogId, CatalogAssemblyUnit[]>();
    for (const unit of input.units) {
      const existing = sources.get(unit.catalog);
      if (existing === undefined) sources.set(unit.catalog, [unit]);
      else existing.push(unit);
    }

    const reachable = new Map<CatalogId, readonly CatalogId[][]>();
    const visit = (
      key: CatalogId,
      path: readonly CatalogId[],
    ): Result.Result<void, InvalidIR> =>
      Result.gen(function* () {
        if (path.includes(key)) {
          return yield* invalid(
            `catalog reachability cycle: ${formatPath([...path, key])}`,
          );
        }
        const listed = sources.get(key);
        if (listed === undefined) {
          return yield* invalid(
            `missing child catalog '${key}' (path: ${formatPath([...path, key])})`,
          );
        }
        const nextPath = [...path, key];
        const paths = reachable.get(key);
        if (paths === undefined) reachable.set(key, [nextPath]);
        else reachable.set(key, [...paths, nextPath]);
        if (paths !== undefined) return;

        const children = [...new Set(listed.flatMap((unit) => unit.children ?? []))].sort(
          compareCatalogId,
        );
        for (const child of children) {
          yield* visit(child, nextPath);
        }
      });

    yield* Effect.fromResult(visit(input.root, []));

    for (const key of sources.keys()) {
      if (!reachable.has(key)) {
        return yield* new InvalidIR({
          message: `unused catalog '${key}' is not reachable from root '${input.root}'`,
        });
      }
    }

    const byKey = new Map<CatalogId, DeployedCatalog>();
    const ordered = [...reachable.keys()].sort(compareCatalogId);
    for (const key of ordered) {
      const listed = sources.get(key);
      if (listed === undefined) {
        return yield* new InvalidIR({
          message: `missing child catalog '${key}'`,
        });
      }
      const assembled: DeployedCatalog[] = [];
      for (const unit of listed) {
        assembled.push(yield* assembleOne(unit));
      }
      const hashes = new Set(assembled.map((item) => item.unitHash));
      if (hashes.size > 1) {
        const paths = (reachable.get(key) ?? []).map(formatPath).join("; ");
        return yield* new InvalidIR({
          message: `duplicate catalog '${key}' with conflicting unit hashes (paths: ${paths})`,
        });
      }
      byKey.set(key, assembled[0]!);
    }

    const byDatabase = new Map<DatabaseId, DeployedCatalog>();
    const deployedUnits = [...byKey.values()].sort((left, right) =>
      compareCatalogId(left.catalogKey, right.catalogKey),
    );
    for (const deployed of deployedUnits) {
      const existing = byDatabase.get(deployed.database);
      if (existing === undefined) {
        byDatabase.set(deployed.database, deployed);
        continue;
      }
      if (
        existing.catalogKey === deployed.catalogKey &&
        existing.unitHash === deployed.unitHash
      ) {
        continue;
      }
      const catalogPaths = [existing.catalogKey, deployed.catalogKey]
        .map((key) => (reachable.get(key) ?? []).map(formatPath).join("; "))
        .join("; ");
      return yield* new InvalidIR({
        message: `distinct catalog units '${existing.catalogKey}' and '${deployed.catalogKey}' claim database '${deployed.database}' (paths: ${catalogPaths})`,
      });
    }

    return buildRegistry(Object.freeze(byDatabase));
  },
);
