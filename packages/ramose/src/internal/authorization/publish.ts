/**
 * Verify-then-publish an installed catalog unit through ordinary `:db/cas`.
 *
 * The sealed unit bytes are the single catalog source. Schema attr +
 * composition datoms are the runtime projection. Resolve reads the head
 * ref and verifies the pointed-at unit against the same kernel.
 */

import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import {
  catalogUnitCanonicalBytes,
  verifyInstalledCatalogUnit,
  type AssembleCatalogUnitFailure,
  type InstalledCatalogUnit,
  type InstalledCatalogUnitV1,
} from "./catalog-unit.ts";
import { decodeInstalledCatalogUnitResult } from "./decode.ts";
import { CatalogMismatch, CatalogUnitCorrupt } from "./failures.ts";
import { CatalogId } from "./identities.ts";
import { catalogPublicationOf, schemaTxFromCatalog } from "./schema-tx.ts";
import type { Connection, TxReport } from "../core/conn.ts";
import type { Db } from "../core/db.ts";
import {
  RAMOSE_CATALOG_HEAD_IDENT,
  RAMOSE_CATALOG_IDENT,
  RAMOSE_CATALOG_UNIT_BYTES_IDENT,
  RAMOSE_CATALOG_UNIT_HASH_IDENT,
} from "../core/schema.ts";
import { type CatalogPublication, type TxData, TxError } from "../core/tx.ts";

export const CATALOG_UNIT_TEMPID = "ramose.catalog.unit";

export type CatalogPublicationTx = TxData;

export type PublishCatalogFailure = AssembleCatalogUnitFailure | CatalogUnitCorrupt | TxError;

const unknownCatalog = CatalogId.make("unknown");

const corrupt = (message: string, catalog: CatalogId = unknownCatalog): CatalogUnitCorrupt =>
  new CatalogUnitCorrupt({ message, catalog });

/**
 * Pure assembly. Caller must pass a verified unit — never an unverified
 * structural document.
 */
export const assembleCatalogPublicationTx = (
  unit: InstalledCatalogUnitV1,
  expectedHead: number | null,
): CatalogPublicationTx => [
  ...schemaTxFromCatalog(unit.catalog),
  [":db/add", CATALOG_UNIT_TEMPID, RAMOSE_CATALOG_UNIT_HASH_IDENT, unit.unitHash],
  [":db/add", CATALOG_UNIT_TEMPID, RAMOSE_CATALOG_UNIT_BYTES_IDENT, catalogUnitCanonicalBytes(unit)],
  [
    ":db/cas",
    [":db/ident", RAMOSE_CATALOG_IDENT],
    RAMOSE_CATALOG_HEAD_IDENT,
    expectedHead,
    CATALOG_UNIT_TEMPID,
  ],
];

export const catalogPublicationFromUnit = (unit: InstalledCatalogUnit): CatalogPublication =>
  catalogPublicationOf(unit.catalog);

/** Current `:ramose.catalog/head` ref, or `null` when absent. */
export const resolveCatalogHead = async (db: Db): Promise<number | null> => {
  const e = db.schema.entid(RAMOSE_CATALOG_IDENT);
  if (e === undefined) return null;
  const row = await db.entity(e);
  const head = row?.[RAMOSE_CATALOG_HEAD_IDENT];
  return typeof head === "number" ? head : null;
};

const decodeUnitBytes = (
  bytes: Uint8Array,
): Effect.Effect<InstalledCatalogUnit, AssembleCatalogUnitFailure | CatalogUnitCorrupt> =>
  Effect.gen(function* () {
    const text = yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      catch: (cause) =>
        corrupt(
          `catalog unit bytes are not valid UTF-8: ${cause instanceof Error ? cause.message : String(cause)}`,
        ),
    });
    const parsed = yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: (cause) =>
        corrupt(
          `catalog unit bytes are not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
        ),
    });
    const decoded = decodeInstalledCatalogUnitResult(parsed);
    if (Result.isFailure(decoded)) return yield* decoded.failure;
    return decoded.success;
  });

/**
 * Read the head, load unitHash+unitBytes, structurally decode, then
 * {@link verifyInstalledCatalogUnit}. Fail closed on missing, corrupt,
 * or disagreeing components.
 */
export const resolveInstalledCatalogUnit = Effect.fn("Authorization.resolveInstalledCatalogUnit")(
  function* (db: Db): Effect.fn.Return<InstalledCatalogUnitV1, AssembleCatalogUnitFailure | CatalogUnitCorrupt> {
    const head = yield* Effect.promise(() => resolveCatalogHead(db));
    if (head === null) {
      return yield* new CatalogMismatch({ message: "catalog head is absent" });
    }
    const row = yield* Effect.promise(() => db.entity(head));
    if (row === undefined) {
      return yield* corrupt("catalog head points at a missing entity");
    }
    const storedHash = row[RAMOSE_CATALOG_UNIT_HASH_IDENT];
    const storedBytes = row[RAMOSE_CATALOG_UNIT_BYTES_IDENT];
    if (typeof storedHash !== "string") {
      return yield* corrupt("catalog unit is missing unitHash");
    }
    if (!(storedBytes instanceof Uint8Array)) {
      return yield* corrupt("catalog unit is missing unitBytes");
    }
    const document = yield* decodeUnitBytes(storedBytes);
    if (document.unitHash !== storedHash) {
      return yield* corrupt(
        "stored unit hash does not match unit document",
        document.catalog.id,
      );
    }
    return yield* verifyInstalledCatalogUnit(document);
  },
);

/**
 * Verify, assemble, and submit through {@link Connection.publishCatalog}.
 * `expectedHead` defaults to the current head (`null` when absent).
 */
export const publishCatalogUnit = Effect.fn("Authorization.publishCatalogUnit")(
  function* (
    conn: Connection,
    document: InstalledCatalogUnit,
    expectedHead?: number | null,
  ): Effect.fn.Return<TxReport, PublishCatalogFailure> {
    const unit = yield* verifyInstalledCatalogUnit(document);
    const head =
      expectedHead !== undefined
        ? expectedHead
        : yield* Effect.promise(() => resolveCatalogHead(conn.db()));
    const tx = assembleCatalogPublicationTx(unit, head);
    return yield* Effect.tryPromise({
      try: () => conn.publishCatalog(tx, catalogPublicationFromUnit(unit)),
      catch: (cause) => {
        if (cause instanceof TxError) return cause;
        return corrupt(
          cause instanceof Error ? cause.message : String(cause),
          unit.catalog.id,
        );
      },
    });
  },
);
