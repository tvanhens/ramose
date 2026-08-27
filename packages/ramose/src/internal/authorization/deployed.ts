/**
 * Immutable deployed-catalog registry.
 *
 * Assembled once at startup from reachable code definitions. The sealed
 * {@link InstalledCatalogUnitV1} is the sole runtime authority. Not a
 * module-global mutable map and not import-order registration.
 */

import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { Unauthorized } from "../../db/Errors.ts";
import type { CatalogDescriptor } from "./catalog.ts";
import type { InstalledCatalogUnitV1 } from "./catalog-unit.ts";
import {
  type AssembleCatalogUnitFailure,
  sealInstalledCatalogUnit,
} from "./catalog-unit.ts";
import { CatalogMismatch, CatalogUnitCorrupt, CatalogVersionMismatch, InvalidIR } from "./failures.ts";
import type { CatalogId, CatalogUnitHash, CatalogVersion, DatabaseId } from "./identities.ts";
import { installAuthorization, type InstallFailure } from "./install.ts";
import type { CatalogBindingTarget, PolicyTemplateIR } from "./ir.ts";

export type CatalogBoundRef = {
  readonly catalogKey: CatalogId;
  readonly unitHash: CatalogUnitHash;
};

export type DeployedCatalog = {
  readonly catalogKey: CatalogId;
  readonly unitHash: CatalogUnitHash;
  readonly unit: InstalledCatalogUnitV1;
};

export type DeployedCatalogs = {
  readonly require: (catalogKey: CatalogId) => Result.Result<DeployedCatalog, CatalogMismatch>;
  readonly keys: () => readonly CatalogId[];
};

export type CatalogAssemblyUnit = {
  readonly catalog: CatalogId;
  readonly database: DatabaseId;
  readonly version: CatalogVersion;
  /** Reachable child catalog keys. Missing child fails assembly. */
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
    return freezePlain({
      catalogKey: unit.catalog,
      unitHash: sealed.unitHash,
      unit: sealed,
    });
  },
);

const buildRegistry = (
  byKey: ReadonlyMap<CatalogId, DeployedCatalog>,
): DeployedCatalogs => {
  const require = (catalogKey: CatalogId): Result.Result<DeployedCatalog, CatalogMismatch> => {
    const deployed = byKey.get(catalogKey);
    if (deployed === undefined) {
      return Result.fail(
        new CatalogMismatch({
          message: "catalog mismatch",
          expected: catalogKey,
        }),
      );
    }
    return Result.succeed(deployed);
  };

  const keys = (): readonly CatalogId[] => Object.freeze([...byKey.keys()].sort(compareCatalogId));

  return Object.freeze({
    require,
    keys,
  });
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

/**
 * Two-step contract: `require(catalogKey)` then `requireUnitHash`.
 * Composes the primitives; does not allocate Effects.
 */
export const resolveDeployedCatalog = (
  catalogs: DeployedCatalogs,
  ref: CatalogBoundRef,
): Result.Result<DeployedCatalog, CatalogMismatch | CatalogVersionMismatch> =>
  Result.gen(function* () {
    const deployed = yield* catalogs.require(ref.catalogKey);
    yield* requireUnitHash(ref.unitHash, deployed.unitHash, ref.catalogKey);
    return deployed;
  });

/** Collapse internal mismatch/missing failures to opaque Unauthorized. No catalog/version details. */
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

    return buildRegistry(Object.freeze(byKey));
  },
);
