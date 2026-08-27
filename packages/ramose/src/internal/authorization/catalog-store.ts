/**
 * Versioned CAS storage for complete {@link InstalledCatalogUnitV1}s.
 *
 * One SQL transaction writes the full canonical unit bytes and then the
 * head pointer. Readers at a basis see either the complete old unit or
 * the complete new unit — never a mix. Constructors and mutation stay
 * internal; this kernel operates on {@link SqlLike}.
 */

import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import {
  catalogUnitCanonicalBytes,
  requireUnitCoherence,
  verifyInstalledCatalogUnit,
  type InstalledCatalogUnitV1,
} from "./catalog-unit.ts";
import { decodeInstalledCatalogUnitResult } from "./decode.ts";
import {
  CatalogCasConflict,
  CatalogMismatch,
  CatalogUnitCorrupt,
  InvalidIR,
  type CatalogStoreFailure,
} from "./failures.ts";
import {
  CatalogId,
  CatalogUnitHash,
  CatalogVersion,
  DatabaseId,
} from "./identities.ts";
import type { SqlLike } from "../transactor/host.ts";

export type { CatalogStoreFailure };

export type CatalogHead = {
  readonly catalog: CatalogId;
  readonly catalogVersion: CatalogVersion;
  readonly installT: number;
  readonly unitHash: CatalogUnitHash;
};

export type CompareAndSwapCatalogUnitInput = {
  readonly database: DatabaseId;
  readonly catalog: CatalogId;
  readonly expectedVersion: CatalogVersion | null;
  readonly unit: InstalledCatalogUnitV1;
  readonly installT: number;
};

export type LoadCatalogUnitInput = {
  readonly database: DatabaseId;
  readonly catalog: CatalogId;
  readonly basisT: number;
};

export type StoredCatalogUnitRow = {
  readonly catalog: CatalogId;
  readonly catalogVersion: CatalogVersion;
  readonly installT: number;
  readonly unitHash: CatalogUnitHash;
  readonly bytes: Uint8Array;
};

const UTF8 = new TextEncoder();
const UTF8_DEC = new TextDecoder();

const CREATE_UNITS = `CREATE TABLE IF NOT EXISTS catalog_units (
  catalog TEXT NOT NULL,
  catalog_version TEXT NOT NULL,
  install_t INTEGER NOT NULL,
  unit_hash TEXT NOT NULL,
  bytes BLOB NOT NULL,
  PRIMARY KEY (catalog, catalog_version)
)`;

const CREATE_HEADS = `CREATE TABLE IF NOT EXISTS catalog_heads (
  catalog TEXT PRIMARY KEY,
  catalog_version TEXT NOT NULL,
  install_t INTEGER NOT NULL,
  unit_hash TEXT NOT NULL
)`;

export const ensureCatalogUnitTables = (sql: SqlLike): void => {
  sql.exec(CREATE_UNITS);
  sql.exec(CREATE_HEADS);
};

const asBytes = (raw: unknown, catalog: CatalogId): Result.Result<Uint8Array, CatalogUnitCorrupt> => {
  if (raw instanceof Uint8Array) return Result.succeed(raw);
  if (raw instanceof ArrayBuffer) return Result.succeed(new Uint8Array(raw));
  if (typeof raw === "string") return Result.succeed(UTF8.encode(raw));
  return Result.fail(
    new CatalogUnitCorrupt({
      message: "catalog unit bytes are not a blob",
      catalog,
    }),
  );
};

const blobParam = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

const casConflict = (
  catalog: CatalogId,
  expectedVersion?: CatalogVersion,
  actualVersion?: CatalogVersion,
): Result.Result<never, CatalogCasConflict> =>
  Result.fail(
    new CatalogCasConflict({
      message: "catalog compare-and-swap conflict",
      catalog,
      ...(expectedVersion !== undefined ? { expectedVersion } : {}),
      ...(actualVersion !== undefined ? { actualVersion } : {}),
    }),
  );

export const readCatalogHead = (sql: SqlLike, catalog: CatalogId): CatalogHead | undefined => {
  ensureCatalogUnitTables(sql);
  const row = sql
    .exec(
      `SELECT catalog, catalog_version, install_t, unit_hash FROM catalog_heads WHERE catalog = ?`,
      catalog,
    )
    .toArray()[0];
  if (row === undefined) return undefined;
  return {
    catalog: CatalogId.make(String(row.catalog)),
    catalogVersion: CatalogVersion.make(String(row.catalog_version)),
    installT: Number(row.install_t),
    unitHash: CatalogUnitHash.make(String(row.unit_hash)),
  };
};

const readUnitRow = (
  sql: SqlLike,
  catalog: CatalogId,
  catalogVersion: CatalogVersion,
): Result.Result<
  { readonly unitHash: CatalogUnitHash; readonly bytes: Uint8Array; readonly installT: number } | undefined,
  CatalogUnitCorrupt
> => {
  const row = sql
    .exec(
      `SELECT unit_hash, bytes, install_t FROM catalog_units WHERE catalog = ? AND catalog_version = ?`,
      catalog,
      catalogVersion,
    )
    .toArray()[0];
  if (row === undefined) return Result.succeed(undefined);
  const bytes = asBytes(row.bytes, catalog);
  if (Result.isFailure(bytes)) return Result.fail(bytes.failure);
  const installT = Number(row.install_t);
  if (!Number.isSafeInteger(installT) || installT < 0) {
    return Result.fail(
      new CatalogUnitCorrupt({
        message: "catalog unit install_t is invalid",
        catalog,
      }),
    );
  }
  return Result.succeed({
    unitHash: CatalogUnitHash.make(String(row.unit_hash)),
    bytes: bytes.success,
    installT,
  });
};

const bytesEqual = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.byteLength !== right.byteLength) return false;
  for (let i = 0; i < left.byteLength; i++) {
    if (left[i] !== right[i]) return false;
  }
  return true;
};

const requireStoredUnitBytes = (
  sql: SqlLike,
  input: CompareAndSwapCatalogUnitInput,
  installT: number,
): Result.Result<void, CatalogUnitCorrupt> =>
  Result.gen(function* () {
    const row = yield* readUnitRow(sql, input.catalog, input.unit.catalogVersion);
    if (row === undefined) {
      return yield* Result.fail(
        new CatalogUnitCorrupt({
          message: "catalog unit row missing for idempotent retry",
          catalog: input.catalog,
        }),
      );
    }
    if (row.installT !== installT) {
      return yield* Result.fail(
        new CatalogUnitCorrupt({
          message: "catalog unit install_t does not match head",
          catalog: input.catalog,
        }),
      );
    }
    if (row.unitHash !== input.unit.unitHash) {
      return yield* Result.fail(
        new CatalogUnitCorrupt({
          message: "catalog unit hash mismatch",
          catalog: input.catalog,
        }),
      );
    }
    if (!bytesEqual(row.bytes, catalogUnitCanonicalBytes(input.unit))) {
      return yield* Result.fail(
        new CatalogUnitCorrupt({
          message: "catalog unit bytes do not match canonical unit",
          catalog: input.catalog,
        }),
      );
    }
  });

const isIdempotentRetry = (
  sql: SqlLike,
  head: CatalogHead,
  input: CompareAndSwapCatalogUnitInput,
): Result.Result<boolean, CatalogUnitCorrupt> =>
  Result.gen(function* () {
    if (head.catalogVersion !== input.unit.catalogVersion || head.unitHash !== input.unit.unitHash) {
      return false;
    }
    yield* requireStoredUnitBytes(sql, input, head.installT);
    return true;
  });

const writeUnitAndHead = (
  sql: SqlLike,
  input: CompareAndSwapCatalogUnitInput,
): Result.Result<CatalogHead, CatalogStoreFailure> =>
  Result.gen(function* () {
    const existing = yield* readUnitRow(sql, input.catalog, input.unit.catalogVersion);
    if (existing !== undefined) {
      return yield* casConflict(
        input.catalog,
        input.expectedVersion ?? undefined,
        input.unit.catalogVersion,
      );
    }
    const bytes = catalogUnitCanonicalBytes(input.unit);
    sql.exec(
      `INSERT INTO catalog_units (catalog, catalog_version, install_t, unit_hash, bytes) VALUES (?, ?, ?, ?, ?)`,
      input.catalog,
      input.unit.catalogVersion,
      input.installT,
      input.unit.unitHash,
      blobParam(bytes),
    );
    sql.exec(
      `INSERT OR REPLACE INTO catalog_heads (catalog, catalog_version, install_t, unit_hash) VALUES (?, ?, ?, ?)`,
      input.catalog,
      input.unit.catalogVersion,
      input.installT,
      input.unit.unitHash,
    );
    return {
      catalog: input.catalog,
      catalogVersion: input.unit.catalogVersion,
      installT: input.installT,
      unitHash: input.unit.unitHash,
    };
  });

const requireCasIdentity = (
  input: CompareAndSwapCatalogUnitInput,
): Result.Result<void, CatalogMismatch | InvalidIR> => {
  if (input.database !== input.unit.database) {
    return Result.fail(
      new CatalogMismatch({
        message: "CAS database does not match unit",
        expectedDatabase: input.database,
        actualDatabase: input.unit.database,
      }),
    );
  }
  if (input.catalog !== input.unit.catalog) {
    return Result.fail(
      new CatalogMismatch({
        message: "CAS catalog does not match unit",
        expected: input.catalog,
        actual: input.unit.catalog,
      }),
    );
  }
  if (!Number.isSafeInteger(input.installT) || input.installT < 0) {
    return Result.fail(new InvalidIR({ message: "installT must be a non-negative safe integer" }));
  }
  return Result.succeed(undefined);
};

/**
 * Compare-and-swap the catalog head to `unit` inside the caller's
 * transaction. Writes bytes before the head pointer.
 */
export const compareAndSwapCatalogUnit = (
  sql: SqlLike,
  input: CompareAndSwapCatalogUnitInput,
): Result.Result<CatalogHead, CatalogStoreFailure> =>
  Result.gen(function* () {
    ensureCatalogUnitTables(sql);
    yield* requireCasIdentity(input);
    yield* requireUnitCoherence(input.unit);
    const head = readCatalogHead(sql, input.catalog);

    if (input.expectedVersion === null) {
      if (head === undefined) {
        return yield* writeUnitAndHead(sql, input);
      }
      if (yield* isIdempotentRetry(sql, head, input)) {
        return head;
      }
      return yield* casConflict(input.catalog, undefined, head.catalogVersion);
    }

    if (head === undefined) {
      return yield* casConflict(input.catalog, input.expectedVersion);
    }
    if (head.catalogVersion !== input.expectedVersion) {
      if (yield* isIdempotentRetry(sql, head, input)) {
        return head;
      }
      return yield* casConflict(input.catalog, input.expectedVersion, head.catalogVersion);
    }
    if (input.unit.catalogVersion === head.catalogVersion) {
      if (yield* isIdempotentRetry(sql, head, input)) {
        return head;
      }
      return yield* casConflict(input.catalog, input.expectedVersion, head.catalogVersion);
    }
    if (input.installT <= head.installT) {
      return yield* casConflict(input.catalog, input.expectedVersion, head.catalogVersion);
    }
    return yield* writeUnitAndHead(sql, input);
  });

export const selectCatalogUnitAtBasis = (
  sql: SqlLike,
  input: LoadCatalogUnitInput,
): Result.Result<StoredCatalogUnitRow, CatalogStoreFailure> => {
  ensureCatalogUnitTables(sql);
  const row = sql
    .exec(
      `SELECT catalog, catalog_version, install_t, unit_hash, bytes
       FROM catalog_units
       WHERE catalog = ? AND install_t <= ?
       ORDER BY install_t DESC
       LIMIT 1`,
      input.catalog,
      input.basisT,
    )
    .toArray()[0];
  if (row === undefined) {
    return Result.fail(
      new CatalogMismatch({
        message: "no installed catalog unit at basis",
        expected: input.catalog,
      }),
    );
  }
  const bytes = asBytes(row.bytes, input.catalog);
  if (Result.isFailure(bytes)) return Result.fail(bytes.failure);
  return Result.succeed({
    catalog: CatalogId.make(String(row.catalog)),
    catalogVersion: CatalogVersion.make(String(row.catalog_version)),
    installT: Number(row.install_t),
    unitHash: CatalogUnitHash.make(String(row.unit_hash)),
    bytes: bytes.success,
  });
};

const corrupt = (catalog: CatalogId, message: string): CatalogUnitCorrupt =>
  new CatalogUnitCorrupt({ message, catalog });

/**
 * Decode stored bytes, match database/catalog and the stored hash, then
 * brand only through {@link verifyInstalledCatalogUnit}.
 */
export const verifyStoredCatalogUnit = Effect.fn("CatalogStore.verifyStoredCatalogUnit")(
  function* (
    row: StoredCatalogUnitRow,
    input: LoadCatalogUnitInput,
  ): Effect.fn.Return<InstalledCatalogUnitV1, CatalogStoreFailure> {
    const parsed = yield* Effect.try({
      try: () => JSON.parse(UTF8_DEC.decode(row.bytes)) as unknown,
      catch: (cause) =>
        corrupt(
          input.catalog,
          `corrupt catalog unit JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
        ),
    });
    const decoded = decodeInstalledCatalogUnitResult(parsed);
    if (Result.isFailure(decoded)) {
      return yield* corrupt(input.catalog, decoded.failure.message);
    }
    const document = decoded.success;
    if (document.database !== input.database) {
      return yield* new CatalogMismatch({
        message: "stored catalog unit database does not match",
        expectedDatabase: input.database,
        actualDatabase: document.database,
      });
    }
    if (document.catalog !== input.catalog) {
      return yield* new CatalogMismatch({
        message: "stored catalog unit catalog does not match",
        expected: input.catalog,
        actual: document.catalog,
      });
    }
    if (document.catalog !== row.catalog) {
      return yield* corrupt(input.catalog, "stored catalog unit catalog does not match row");
    }
    if (document.catalogVersion !== row.catalogVersion) {
      return yield* corrupt(input.catalog, "stored catalog unit version does not match row");
    }
    if (document.unitHash !== row.unitHash) {
      return yield* corrupt(input.catalog, "catalog unit hash mismatch");
    }
    return yield* verifyInstalledCatalogUnit(document);
  },
);

export const loadCatalogUnitAtBasis = Effect.fn("CatalogStore.loadCatalogUnitAtBasis")(
  function* (
    sql: SqlLike,
    input: LoadCatalogUnitInput,
  ): Effect.fn.Return<InstalledCatalogUnitV1, CatalogStoreFailure> {
    const row = yield* Effect.fromResult(selectCatalogUnitAtBasis(sql, input));
    return yield* verifyStoredCatalogUnit(row, input);
  },
);
