/**
 * Verify-then-publish an installed catalog unit through ordinary `:db/cas`.
 *
 * The sealed unit bytes are the single catalog source. Schema attr +
 * composition datoms are the runtime projection. Resolve reads the head
 * ref and verifies the pointed-at unit against the same kernel.
 */

import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type { CatalogDescriptor } from "./catalog.ts";
import {
  catalogUnitCanonicalBytes,
  verifyInstalledCatalogUnit,
  type AssembleCatalogUnitFailure,
  type InstalledCatalogUnit,
  type InstalledCatalogUnitV1,
} from "./catalog-unit.ts";
import { decodeInstalledCatalogUnitResult } from "./decode.ts";
import { CatalogMismatch, CatalogUnitCorrupt } from "./failures.ts";
import { CatalogId, type DatabaseId } from "./identities.ts";
import { catalogPublicationOf, composerIdentFromName, schemaTxFromCatalog } from "./schema-tx.ts";
import { installTx, type InstalledAttr } from "../../db/evolution.ts";
import type { Connection, TxReport } from "../core/conn.ts";
import type { Db } from "../core/db.ts";
import { Index } from "../core/datom.ts";
import {
  RAMOSE_CATALOG_HEAD_IDENT,
  RAMOSE_CATALOG_IDENT,
  RAMOSE_CATALOG_UNIT_BYTES_IDENT,
  RAMOSE_CATALOG_UNIT_HASH_IDENT,
  RAMOSE_COMPOSES_IDENT,
  VALUE_TYPE_NAMES,
  type Schema,
} from "../core/schema.ts";
import { type CatalogPublication, type TxData, TxError } from "../core/tx.ts";

export const CATALOG_UNIT_TEMPID = "ramose.catalog.unit";

export type CatalogPublicationTx = TxData;

export type PublishCatalogFailure = AssembleCatalogUnitFailure | CatalogUnitCorrupt | TxError;

const unknownCatalog = CatalogId.make("unknown");

const corrupt = (message: string, catalog: CatalogId = unknownCatalog): CatalogUnitCorrupt =>
  new CatalogUnitCorrupt({ message, catalog });

/** Direct `:ramose/composes` edges the catalog's schema projection would add. */
const directCompositionOf = (catalog: CatalogDescriptor): Map<string, Set<string>> => {
  const wanted = new Map<string, Set<string>>();
  const add = (composer: string, traits: readonly { readonly name: string }[]): void => {
    const set = wanted.get(composer) ?? new Set<string>();
    for (const trait of traits) set.add(composerIdentFromName(trait.name));
    wanted.set(composer, set);
  };
  for (const entity of catalog.entities) add(composerIdentFromName(entity.id.name), entity.traits);
  for (const trait of catalog.traits) add(composerIdentFromName(trait.id.name), trait.traits);
  return wanted;
};

/**
 * Retract db-before `:ramose/composes` edges that the new catalog does not
 * assert. Schema projection is add-only; without these retracts,
 * `Schema.transitiveTraits` would keep dropped traits. Occupied types whose
 * closure would change still abort via `tx/occupied-type` in `processTx`.
 */
export const catalogCompositionRetracts = async (
  db: Db,
  catalog: CatalogDescriptor,
): Promise<CatalogPublicationTx> => {
  const attr = db.attr(RAMOSE_COMPOSES_IDENT);
  if (attr === undefined) return [];
  const wanted = directCompositionOf(catalog);
  const retracts: CatalogPublicationTx = [];
  for (const d of await db.datomsArray(Index.AEVT, { a: attr.id })) {
    if (typeof d.v !== "string") continue;
    const composer = db.schema.ident(d.e);
    if (composer === undefined) continue;
    const keep = wanted.get(composer);
    if (keep !== undefined && keep.has(d.v)) continue;
    retracts.push([":db/retract", composer, RAMOSE_COMPOSES_IDENT, d.v]);
  }
  return retracts;
};

const installedAttrsFromSchema = (schema: Schema): InstalledAttr[] => {
  const out: InstalledAttr[] = [];
  for (const a of schema.attributes()) {
    if (a.ident.startsWith(":db/")) continue;
    const valueType = VALUE_TYPE_NAMES[a.valueType];
    if (valueType === undefined) continue;
    out.push({
      e: a.id,
      ident: a.ident,
      valueType,
      cardinality: `:db.cardinality/${a.cardinality}`,
      ...(a.unique !== undefined ? { unique: `:db.unique/${a.unique}` } : {}),
      ...(a.optional ? { optional: true } : {}),
    });
  }
  return out;
};

/**
 * Pure assembly. Caller must pass a verified unit — never an unverified
 * structural document. `installed` is required (read from db-before) so
 * optional→required retracts are never silently skipped. `compositionRetracts`
 * are also computed from db-before.
 */
export const assembleCatalogPublicationTx = ({
  unit,
  expectedHead,
  installed,
  compositionRetracts = [],
}: {
  readonly unit: InstalledCatalogUnitV1;
  readonly expectedHead: number | null;
  readonly installed: readonly InstalledAttr[];
  readonly compositionRetracts?: CatalogPublicationTx;
}): CatalogPublicationTx => [
  ...compositionRetracts,
  ...installTx(schemaTxFromCatalog(unit.catalog), installed),
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
    writerDatabase?: DatabaseId,
  ): Effect.fn.Return<TxReport, PublishCatalogFailure> {
    const unit = yield* verifyInstalledCatalogUnit(document);
    if (writerDatabase !== undefined && unit.catalog.database !== writerDatabase) {
      return yield* new CatalogMismatch({
        message: "cross-database catalog",
        expectedDatabase: writerDatabase,
        actualDatabase: unit.catalog.database,
      });
    }
    const db = conn.db();
    const head =
      expectedHead !== undefined
        ? expectedHead
        : yield* Effect.promise(() => resolveCatalogHead(db));
    const retracts = yield* Effect.promise(() => catalogCompositionRetracts(db, unit.catalog));
    const tx = assembleCatalogPublicationTx({
      unit,
      expectedHead: head,
      installed: installedAttrsFromSchema(db.schema),
      compositionRetracts: retracts,
    });
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
