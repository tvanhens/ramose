/**
 * Catalog publication: CAS of an engine-owned head in one ordinary tx.
 */

import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { Connection } from "../../../src/internal/core/conn.ts";
import { Index, ValueTag } from "../../../src/internal/core/datom.ts";
import {
  DB_IDENT,
  FIRST_USER_EID,
  RAMOSE_CATALOG,
  RAMOSE_CATALOG_HEAD,
  RAMOSE_CATALOG_HEAD_IDENT,
  RAMOSE_CATALOG_IDENT,
  RAMOSE_CATALOG_UNIT_BYTES,
  RAMOSE_CATALOG_UNIT_BYTES_IDENT,
  RAMOSE_CATALOG_UNIT_HASH,
  RAMOSE_CATALOG_UNIT_HASH_IDENT,
  RAMOSE_KIND_ENTITY,
  RAMOSE_KIND_TRAIT,
  Schema,
  bootstrapDatoms,
  missingBootstrapDatoms,
} from "../../../src/internal/core/schema.ts";
import { TxError } from "../../../src/internal/core/tx.ts";
import {
  CatalogMismatch,
  CatalogUnitCorrupt,
  InvalidIR,
  assembleCatalogPublicationTx,
  catalogPublicationFromUnit,
  catalogUnitCanonicalBytes,
  decodeInstalledCatalogUnitResult,
  encodeInstalledCatalogUnit,
  publishCatalogUnit,
  resolveCatalogHead,
  resolveInstalledCatalogUnit,
  schemaTxFromCatalog,
  type InstalledCatalogUnit,
  type InstalledCatalogUnitV1,
} from "../../../src/internal/authorization/index.ts";
import {
  catalogDescriptor,
  database,
  evolvedCatalogDescriptor,
  extraRequiredFieldCatalogDescriptor,
  optionalTitleCatalogDescriptor,
  reducedCatalogDescriptor,
  sealUnit,
  titleValueTypeLongCatalogDescriptor,
} from "./catalog-unit-fixtures.ts";
import { DatabaseId } from "../../../src/internal/authorization/identities.ts";
import { buildRoots } from "../../../src/internal/core/conn.ts";
import { MemStore } from "../../../src/internal/core/store.ts";

const publish = (conn: Connection, unit: InstalledCatalogUnit, expectedHead?: number | null) =>
  Effect.runPromise(publishCatalogUnit(conn, unit, expectedHead));

const resolve = (db: Parameters<typeof resolveInstalledCatalogUnit>[0]) =>
  Effect.runPromise(resolveInstalledCatalogUnit(db));

const resolveFail = (db: Parameters<typeof resolveInstalledCatalogUnit>[0]) =>
  Effect.runPromise(Effect.flip(resolveInstalledCatalogUnit(db)));

const requireSealed = (_unit: InstalledCatalogUnitV1): void => undefined;

describe("first publish", () => {
  test("expectedHead null commits schema, unit hash/bytes, and head atomically", async () => {
    const conn = await Connection.create({ now: () => 1_700_000_000_000 });
    const unit = await sealUnit();
    expect(await resolveCatalogHead(conn.db())).toBeNull();

    const report = await publish(conn, unit);
    expect(report.t).toBe(2);
    const db = conn.db();
    const head = await resolveCatalogHead(db);
    expect(typeof head).toBe("number");
    const catalog = await db.entity(RAMOSE_CATALOG);
    expect(catalog?.[RAMOSE_CATALOG_HEAD_IDENT]).toBe(head);
    const row = await db.entity(head!);
    expect(row?.[RAMOSE_CATALOG_UNIT_HASH_IDENT]).toBe(unit.unitHash);
    expect(row?.[RAMOSE_CATALOG_UNIT_BYTES_IDENT]).toEqual(catalogUnitCanonicalBytes(unit));

    expect(db.schema.entid(":issue/title")).toBeDefined();
    expect(db.schema.entid(":user/authId")).toBeDefined();
    expect(db.schema.entid(":taggable/tags")).toBeDefined();
    expect(db.schema.kindOf(":issue")).toBe(RAMOSE_KIND_ENTITY);
    expect(db.schema.kindOf(":user")).toBe(RAMOSE_KIND_ENTITY);
    expect(db.schema.kindOf(":taggable")).toBe(RAMOSE_KIND_TRAIT);
    expect(db.schema.transitiveTraits(":issue")).toEqual([":taggable"]);
    expect(db.schema.attr(":user/authId")?.unique).toBe("identity");
  });

  test("resolveInstalledCatalogUnit returns the verified unit", async () => {
    const conn = await Connection.create();
    const unit = await sealUnit();
    await publish(conn, unit);
    const resolved = await resolve(conn.db());
    requireSealed(resolved);
    expect(resolved.unitHash).toBe(unit.unitHash);
    expect(resolved.catalog.version).toBe(unit.catalog.version);
    expect(resolved.catalog.fingerprint).toBe(unit.catalog.fingerprint);
    expect(resolved.catalog.operations.map((op) => op.id.localName)).toEqual(["rename"]);
    expect(resolved.policy.policyHash).toBe(unit.policy.policyHash);
    expect(resolved.policy.rules.map((rule) => rule.id)).toEqual(unit.policy.rules.map((rule) => rule.id));
  });

  test("typed create after publish stamps type and transitive traits", async () => {
    const conn = await Connection.create();
    await publish(conn, await sealUnit());
    const created = await conn.transact([
      { ":db/id": "u", ":user/authId": "ada" },
      { ":db/id": "i", ":issue/title": "Bug", ":issue/owner": "u" },
    ]);
    const issue = await conn.db().entity(created.tempids.i);
    expect(issue?.[":ramose/type"]).toBe(":issue");
    expect(issue?.[":ramose/trait"]).toEqual([":taggable"]);
    const user = await conn.db().entity(created.tempids.u);
    expect(user?.[":ramose/type"]).toBe(":user");
  });
});

describe("CAS / all-or-nothing", () => {
  test("concurrent publish with the same expected head: exactly one wins", async () => {
    const conn = await Connection.create();
    const first = await sealUnit();
    const second = await sealUnit(await evolvedCatalogDescriptor());
    const settled = await Promise.allSettled([
      publish(conn, first, null),
      publish(conn, second, null),
    ]);
    const ok = settled.filter((s) => s.status === "fulfilled");
    const bad = settled.filter((s) => s.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect((bad[0] as PromiseRejectedResult).reason).toMatchObject({ code: "tx/cas-conflict" });
    expect((bad[0] as PromiseRejectedResult).reason).toBeInstanceOf(TxError);

    const resolved = await resolve(conn.db());
    const winnerHash = resolved.unitHash;
    expect(winnerHash === first.unitHash || winnerHash === second.unitHash).toBe(true);
    const loser = winnerHash === first.unitHash ? second : first;
    expect(await conn.db().entid([RAMOSE_CATALOG_UNIT_HASH_IDENT, loser.unitHash])).toBeUndefined();
    if (winnerHash === first.unitHash) {
      expect(conn.db().schema.kindOf(":named")).toBeUndefined();
    }
  });

  test("wrong expected head aborts sibling schema and unit ops", async () => {
    const conn = await Connection.create();
    const unit = await sealUnit();
    const t = conn.t;
    await expect(publish(conn, unit, 99_999)).rejects.toMatchObject({ code: "tx/cas-conflict" });
    expect(conn.t).toBe(t);
    expect(await resolveCatalogHead(conn.db())).toBeNull();
    expect(conn.db().schema.entid(":issue/title")).toBeUndefined();
    expect(await conn.db().entid([RAMOSE_CATALOG_UNIT_HASH_IDENT, unit.unitHash])).toBeUndefined();
  });

  test("CAS mismatch after a successful publish leaves the first unit intact", async () => {
    const conn = await Connection.create();
    const v1 = await sealUnit();
    await publish(conn, v1);
    const head = await resolveCatalogHead(conn.db());
    const v2 = await sealUnit(await evolvedCatalogDescriptor());
    const t = conn.t;
    await expect(publish(conn, v2, null)).rejects.toMatchObject({ code: "tx/cas-conflict" });
    expect(conn.t).toBe(t);
    expect(await resolveCatalogHead(conn.db())).toBe(head);
    const resolved = await resolve(conn.db());
    expect(resolved.unitHash).toBe(v1.unitHash);
    expect(conn.db().schema.kindOf(":named")).toBeUndefined();
  });
});

describe("as-of / history", () => {
  test("after two publishes, asOf(t1) resolves the old unit and current the new", async () => {
    const conn = await Connection.create();
    const v1 = await sealUnit();
    const r1 = await publish(conn, v1);
    const head1 = await resolveCatalogHead(conn.db());
    if (head1 === null) throw new Error("expected catalog head after first publish");
    const v2 = await sealUnit(await evolvedCatalogDescriptor());
    await publish(conn, v2);
    const head2 = await resolveCatalogHead(conn.db());
    if (head2 === null) throw new Error("expected catalog head after second publish");
    expect(head2).not.toBe(head1);

    const asOf = await resolve(conn.db().asOf(r1.t));
    requireSealed(asOf);
    expect(asOf.unitHash).toBe(v1.unitHash);
    expect(asOf.catalog.version).toBe(v1.catalog.version);
    expect(asOf.catalog.entities.find((e) => e.id.name === "issue")?.traits.map((t) => t.name)).toEqual([
      "taggable",
    ]);

    const current = await resolve(conn.db());
    expect(current.unitHash).toBe(v2.unitHash);
    expect(current.catalog.version).toBe(v2.catalog.version);
    expect(current.catalog.entities.find((e) => e.id.name === "issue")?.traits.map((t) => t.name)).toEqual([
      "named",
      "taggable",
    ]);

    const headAttr = conn.db().attr(RAMOSE_CATALOG_HEAD_IDENT)!;
    const hist = await conn.db().history().datomsArray(Index.EAVT, { e: RAMOSE_CATALOG, a: headAttr.id });
    expect(hist.map((d) => [d.v, d.op])).toEqual([
      [head1, true],
      [head1, false],
      [head2, true],
    ]);
  });
});

describe("fail closed", () => {
  test("absent head / missing components / corrupt bytes / hash mismatch", async () => {
    const conn = await Connection.create();
    const absent = await resolveFail(conn.db());
    expect(absent).toBeInstanceOf(CatalogMismatch);
    expect(absent.message).toMatch(/catalog head is absent/);

    const unit = await sealUnit();
    const publication = catalogPublicationFromUnit(unit);
    await conn.publishCatalog(
      [
        { ":db/id": "partial", [RAMOSE_CATALOG_UNIT_HASH_IDENT]: unit.unitHash },
        [":db/cas", [":db/ident", RAMOSE_CATALOG_IDENT], RAMOSE_CATALOG_HEAD_IDENT, null, "partial"],
      ],
      publication,
    );
    const missingBytes = await resolveFail(conn.db());
    expect(missingBytes).toBeInstanceOf(CatalogUnitCorrupt);
    expect(missingBytes.message).toMatch(/missing unitBytes/);

    const head = await resolveCatalogHead(conn.db());
    await conn.publishCatalog(
      [
        {
          ":db/id": "corrupt",
          [RAMOSE_CATALOG_UNIT_HASH_IDENT]: "a".repeat(64),
          [RAMOSE_CATALOG_UNIT_BYTES_IDENT]: new Uint8Array([1, 2, 3]),
        },
        [":db/cas", [":db/ident", RAMOSE_CATALOG_IDENT], RAMOSE_CATALOG_HEAD_IDENT, head, "corrupt"],
      ],
      publication,
    );
    const corrupt = await resolveFail(conn.db());
    expect(
      corrupt instanceof CatalogUnitCorrupt ||
        corrupt instanceof InvalidIR ||
        corrupt instanceof CatalogMismatch,
    ).toBe(true);
    expect(corrupt.message).toMatch(/JSON|UTF-8|hash|unit|decode|Expected|Struct/i);
  });

  test("structurally decoded sealed unit is re-verified and publishes", async () => {
    const conn = await Connection.create();
    const unit = await sealUnit();
    const structural = decodeInstalledCatalogUnitResult(encodeInstalledCatalogUnit(unit));
    expect(structural._tag).toBe("Success");
    if (structural._tag !== "Success") return;
    const decoded: InstalledCatalogUnit = structural.success;
    await expect(publish(conn, decoded)).resolves.toMatchObject({ t: 2 });
    expect(await resolveCatalogHead(conn.db())).toBeTypeOf("number");
  });

  test("forged unit hash is rejected before assemble", async () => {
    const conn = await Connection.create();
    const unit = await sealUnit();
    const structural = decodeInstalledCatalogUnitResult(encodeInstalledCatalogUnit(unit));
    expect(structural._tag).toBe("Success");
    if (structural._tag !== "Success") return;
    const forged = { ...structural.success, unitHash: "0".repeat(64) } as InstalledCatalogUnit;
    const t = conn.t;
    await expect(publish(conn, forged, null)).rejects.toBeInstanceOf(CatalogUnitCorrupt);
    expect(conn.t).toBe(t);
    expect(await resolveCatalogHead(conn.db())).toBeNull();
  });

  test("unit/head disagreement: stored hash does not match bytes", async () => {
    const conn = await Connection.create();
    const unit = await sealUnit();
    const other = await sealUnit(await evolvedCatalogDescriptor());
    const publication = catalogPublicationFromUnit(unit);
    await conn.publishCatalog(
      [
        {
          ":db/id": "disagree",
          [RAMOSE_CATALOG_UNIT_HASH_IDENT]: other.unitHash,
          [RAMOSE_CATALOG_UNIT_BYTES_IDENT]: catalogUnitCanonicalBytes(unit),
        },
        [":db/cas", [":db/ident", RAMOSE_CATALOG_IDENT], RAMOSE_CATALOG_HEAD_IDENT, null, "disagree"],
      ],
      publication,
    );
    const failure = await resolveFail(conn.db());
    expect(failure).toBeInstanceOf(CatalogUnitCorrupt);
    expect(failure.message).toMatch(/hash does not match|hash mismatch/);
  });
});

describe("catalog-unit retractEntity", () => {
  test("numeric eid, lookup, and historical unit retracts are tx/system", async () => {
    const conn = await Connection.create();
    const v1 = await sealUnit();
    await publish(conn, v1);
    const head1 = await resolveCatalogHead(conn.db());
    if (head1 === null) throw new Error("expected head");
    await conn.transact([{ ":db/id": "u", ":user/authId": "ada" }]);
    const v2 = await sealUnit(await evolvedCatalogDescriptor());
    await publish(conn, v2);
    const head2 = await resolveCatalogHead(conn.db());
    if (head2 === null) throw new Error("expected head after v2");
    const t = conn.t;
    const hash1 = v1.unitHash;
    const bytes1 = (await conn.db().entity(head1))?.[RAMOSE_CATALOG_UNIT_BYTES_IDENT];

    await expect(conn.transact([[":db/retractEntity", head1]])).rejects.toMatchObject({
      code: "tx/system",
    });
    await expect(conn.transact([[":db/retractEntity", head2]])).rejects.toMatchObject({
      code: "tx/system",
    });
    await expect(
      conn.transact([[":db/retractEntity", [RAMOSE_CATALOG_UNIT_HASH_IDENT, hash1]]]),
    ).rejects.toMatchObject({ code: "tx/system" });
    expect(conn.t).toBe(t);
    expect(await resolveCatalogHead(conn.db())).toBe(head2);
    const historical = await conn.db().entity(head1);
    expect(historical?.[RAMOSE_CATALOG_UNIT_HASH_IDENT]).toBe(hash1);
    expect(historical?.[RAMOSE_CATALOG_UNIT_BYTES_IDENT]).toEqual(bytes1);
  });

  test("ordinary retractEntity of a user entity still works", async () => {
    const conn = await Connection.create();
    await publish(conn, await sealUnit());
    const created = await conn.transact([{ ":db/id": "u", ":user/authId": "ada" }]);
    const eid = created.tempids.u;
    await conn.transact([[":db/retractEntity", eid]]);
    expect(await conn.db().entity(eid)).toBeUndefined();
  });
});

describe("field evolution at publish", () => {
  test("occupied namespace + new required field is tx/incompatible-schema", async () => {
    const conn = await Connection.create();
    await publish(conn, await sealUnit());
    await conn.transact([
      { ":db/id": "u", ":user/authId": "ada" },
      { ":db/id": "i", ":issue/title": "Bug", ":issue/owner": "u" },
    ]);
    const t = conn.t;
    const v2 = await sealUnit(await extraRequiredFieldCatalogDescriptor());
    await expect(publish(conn, v2)).rejects.toMatchObject({ code: "tx/incompatible-schema" });
    expect(conn.t).toBe(t);
    expect(await resolveCatalogHead(conn.db())).toBeTypeOf("number");
    expect(conn.db().schema.attr(":issue/priority")).toBeUndefined();
  });

  test("publishCatalog without schemaTx still checks evolution from the tx", async () => {
    const conn = await Connection.create();
    await publish(conn, await sealUnit());
    const t = conn.t;
    const { schemaTx: _schemaTx, ...publication } = catalogPublicationFromUnit(await sealUnit());
    await expect(
      conn.publishCatalog(
        [
          {
            ":db/ident": ":issue/title",
            ":db/valueType": ":db.type/long",
            ":db/cardinality": ":db.cardinality/one",
          },
        ],
        publication,
      ),
    ).rejects.toMatchObject({ code: "tx/incompatible-schema" });
    expect(conn.t).toBe(t);
    expect(conn.db().schema.attr(":issue/title")?.valueType).toBe(ValueTag.Str);
  });

  test("valueType flip is tx/incompatible-schema and leaves head null on first publish", async () => {
    const conn = await Connection.create();
    await conn.transact([
      {
        ":db/ident": ":issue/title",
        ":db/valueType": ":db.type/string",
        ":db/cardinality": ":db.cardinality/one",
        ":db/optional": true,
      },
    ]);
    const t = conn.t;
    const unit = await sealUnit(await titleValueTypeLongCatalogDescriptor());
    await expect(publish(conn, unit)).rejects.toMatchObject({ code: "tx/incompatible-schema" });
    expect(conn.t).toBe(t);
    expect(await resolveCatalogHead(conn.db())).toBeNull();
    expect(conn.db().schema.attr(":issue/title")?.valueType).toBe(ValueTag.Str);
  });

  test("first publish on an empty DB still succeeds", async () => {
    const conn = await Connection.create();
    await publish(conn, await sealUnit());
    expect(await resolveCatalogHead(conn.db())).toBeTypeOf("number");
  });
});

describe("optional → required retracts :db/optional", () => {
  test("publish making a seeded optional field required retracts the flag", async () => {
    const conn = await Connection.create();
    await publish(conn, await sealUnit(await optionalTitleCatalogDescriptor()));
    expect(conn.db().schema.attr(":issue/title")?.optional).toBe(true);
    await publish(conn, await sealUnit());
    expect(conn.db().schema.attr(":issue/title")?.optional).toBe(false);
    const titleEid = conn.db().schema.entid(":issue/title")!;
    const optionalAttr = conn.db().attr(":db/optional")!;
    expect(await conn.db().first(Index.EAVT, { e: titleEid, a: optionalAttr.id })).toBeUndefined();
    await conn.transact([{ ":db/id": "u", ":user/authId": "ada" }]);
    await expect(
      conn.transact([{ ":db/id": "i", ":issue/owner": [":user/authId", "ada"] }]),
    ).rejects.toMatchObject({ code: "tx/required" });
  });
});

describe("writer database identity", () => {
  test("publishCatalogUnit rejects a writerDatabase that does not match the unit", async () => {
    const conn = await Connection.create();
    const unit = await sealUnit();
    expect(unit.catalog.database).toBe(database);
    const t = conn.t;
    await expect(
      Effect.runPromise(publishCatalogUnit(conn, unit, null, DatabaseId.make("other"))),
    ).rejects.toBeInstanceOf(CatalogMismatch);
    expect(conn.t).toBe(t);
    expect(await resolveCatalogHead(conn.db())).toBeNull();
  });

  test("matching writerDatabase still publishes", async () => {
    const conn = await Connection.create();
    const unit = await sealUnit();
    await expect(
      Effect.runPromise(publishCatalogUnit(conn, unit, null, database)),
    ).resolves.toMatchObject({ t: 2 });
  });
});

describe("tempid alias onto the catalog singleton", () => {
  test("map that unique-upserts onto entity 21 is tx/system", async () => {
    const conn = await Connection.create();
    await expect(
      conn.transact([{ ":db/id": "c", ":db/ident": RAMOSE_CATALOG_IDENT, ":db/doc": "x" }]),
    ).rejects.toMatchObject({ code: "tx/system" });
    await expect(
      conn.transact([
        { ":db/id": "c", ":db/ident": RAMOSE_CATALOG_IDENT },
        [":db/retractEntity", "c"],
      ]),
    ).rejects.toMatchObject({ code: "tx/system" });
  });

  test("legitimate unique upserts on non-catalog attrs still work", async () => {
    const conn = await Connection.create();
    await publish(conn, await sealUnit());
    const first = await conn.transact([{ ":db/id": "a", ":user/authId": "ada" }]);
    const second = await conn.transact([{ ":db/id": "b", ":user/authId": "ada" }]);
    expect(second.tempids.b).toBe(first.tempids.a);
  });
});

describe("durable catalog bootstrap migration", () => {
  const oldBootstrap = () =>
    bootstrapDatoms().filter(
      (d) =>
        d.e !== RAMOSE_CATALOG &&
        d.e !== RAMOSE_CATALOG_HEAD &&
        d.e !== RAMOSE_CATALOG_UNIT_HASH &&
        d.e !== RAMOSE_CATALOG_UNIT_BYTES,
    );

  test("restore of a pre-catalog log gets entity 21; second migrate is empty", async () => {
    const store = new MemStore();
    const old = oldBootstrap();
    const schema = new Schema().apply(old);
    const roots = await buildRoots(store, schema, old);
    const conn = await Connection.restore(store, roots, [], FIRST_USER_EID);
    expect(await conn.db().entid(RAMOSE_CATALOG_IDENT)).toBeUndefined();
    const missing = await missingBootstrapDatoms(conn.db(), conn.t + 1);
    expect(missing.some((d) => d.e === RAMOSE_CATALOG && d.a === DB_IDENT)).toBe(true);
    conn.applyDatoms(missing);
    expect(await conn.db().entid(RAMOSE_CATALOG_IDENT)).toBe(RAMOSE_CATALOG);
    expect(await conn.db().exists(RAMOSE_CATALOG)).toBe(true);
    const again = await missingBootstrapDatoms(conn.db(), conn.t + 1);
    expect(again).toEqual([]);
    await publish(conn, await sealUnit());
    expect(await resolveCatalogHead(conn.db())).toBeTypeOf("number");
  });
});

describe("post-publish schema projection is engine-owned", () => {
  test("ordinary and fromOperation writes of catalog-projected metadata are tx/system", async () => {
    const conn = await Connection.create();
    await publish(conn, await sealUnit());
    const t = conn.t;
    await expect(
      conn.transact([{ ":db/ident": ":issue/title", ":db/valueType": ":db.type/long" }]),
    ).rejects.toMatchObject({ code: "tx/system" });
    await expect(
      conn.transact([{ ":db/ident": ":issue", ":ramose/composes": ":named" }]),
    ).rejects.toMatchObject({ code: "tx/system" });
    await expect(
      conn.transact([{ ":db/ident": ":issue", ":ramose/kind": ":ramose.kind/trait" }]),
    ).rejects.toMatchObject({ code: "tx/system" });
    await expect(
      conn.transact([{ ":db/ident": ":issue/title", ":db/valueType": ":db.type/long" }], {
        fromOperation: true,
      }),
    ).rejects.toMatchObject({ code: "tx/system" });
    await expect(
      conn.transact([{ ":db/ident": ":issue", ":ramose/kind": ":ramose.kind/trait" }], {
        fromOperation: true,
      }),
    ).rejects.toMatchObject({ code: "tx/system" });
    expect(conn.t).toBe(t);
    expect(conn.db().schema.attr(":issue/title")?.valueType).toBe(ValueTag.Str);
    expect(conn.db().schema.kindOf(":issue")).toBe(RAMOSE_KIND_ENTITY);
  });

  test("ordinary tx cannot mint a net-new attribute after publish", async () => {
    const conn = await Connection.create();
    await publish(conn, await sealUnit());
    const t = conn.t;
    await expect(
      conn.transact([
        {
          ":db/ident": ":evil/spy",
          ":db/valueType": ":db.type/string",
          ":db/cardinality": ":db.cardinality/one",
        },
      ]),
    ).rejects.toMatchObject({ code: "tx/system" });
    await expect(
      conn.transact(
        [
          {
            ":db/ident": ":evil/spy",
            ":db/valueType": ":db.type/string",
            ":db/cardinality": ":db.cardinality/one",
          },
        ],
        { fromOperation: true },
      ),
    ).rejects.toMatchObject({ code: "tx/system" });
    expect(conn.t).toBe(t);
    expect(conn.db().schema.attr(":evil/spy")).toBeUndefined();
  });

  test("ordinary tx cannot mint a net-new composer after publish", async () => {
    const conn = await Connection.create();
    await publish(conn, await sealUnit());
    const t = conn.t;
    await expect(
      conn.transact([{ ":db/ident": ":backdoor", ":ramose/kind": ":ramose.kind/entity" }]),
    ).rejects.toMatchObject({ code: "tx/system" });
    await expect(
      conn.transact([{ ":db/ident": ":backdoor", ":ramose/composes": ":taggable" }]),
    ).rejects.toMatchObject({ code: "tx/system" });
    await expect(
      conn.transact([{ ":db/ident": ":backdoor", ":ramose/kind": ":ramose.kind/entity" }], {
        fromOperation: true,
      }),
    ).rejects.toMatchObject({ code: "tx/system" });
    expect(conn.t).toBe(t);
    expect(conn.db().schema.kindOf(":backdoor")).toBeUndefined();
  });

  test("retractEntity of a projected field or composer is tx/system", async () => {
    const conn = await Connection.create();
    await publish(conn, await sealUnit());
    const t = conn.t;
    await expect(conn.transact([[":db/retractEntity", ":issue/title"]])).rejects.toMatchObject({
      code: "tx/system",
    });
    await expect(conn.transact([[":db/retractEntity", ":issue"]])).rejects.toMatchObject({
      code: "tx/system",
    });
    expect(conn.t).toBe(t);
    expect(conn.db().schema.attr(":issue/title")).toBeDefined();
    expect(conn.db().schema.kindOf(":issue")).toBe(RAMOSE_KIND_ENTITY);
  });

  test("user data writes and typed create still work after publish", async () => {
    const conn = await Connection.create();
    await publish(conn, await sealUnit());
    const created = await conn.transact([
      { ":db/id": "u", ":user/authId": "ada" },
      { ":db/id": "i", ":issue/title": "Bug", ":issue/owner": "u" },
    ]);
    const issue = await conn.db().entity(created.tempids.i);
    expect(issue?.[":issue/title"]).toBe("Bug");
    expect(issue?.[":ramose/type"]).toBe(":issue");
    expect(issue?.[":ramose/trait"]).toEqual([":taggable"]);
    await conn.transact([[":db/add", created.tempids.i, ":issue/title", "Fixed"]]);
    expect((await conn.db().entity(created.tempids.i))?.[":issue/title"]).toBe("Fixed");
  });
});

describe("privilege", () => {
  test("ordinary transact cannot write catalog control attrs", async () => {
    const conn = await Connection.create();
    const unit = await sealUnit();
    const t = conn.t;
    await expect(
      conn.transact([
        [":db/cas", [":db/ident", RAMOSE_CATALOG_IDENT], RAMOSE_CATALOG_HEAD_IDENT, null, 1000],
      ]),
    ).rejects.toMatchObject({ code: "tx/system" });
    await expect(
      conn.transact([[":db/add", "u", RAMOSE_CATALOG_UNIT_HASH_IDENT, unit.unitHash]]),
    ).rejects.toMatchObject({ code: "tx/system" });
    await expect(
      conn.transact([
        [":db/add", "u", RAMOSE_CATALOG_UNIT_BYTES_IDENT, catalogUnitCanonicalBytes(unit)],
      ]),
    ).rejects.toMatchObject({ code: "tx/system" });
    await expect(conn.transact([[":db/retractEntity", RAMOSE_CATALOG_IDENT]])).rejects.toMatchObject({
      code: "tx/system",
    });
    await expect(
      conn.transact([{ ":db/id": RAMOSE_CATALOG, ":db/doc": "nope" }] as unknown[]),
    ).rejects.toMatchObject({ code: "tx/system" });
    await expect(
      conn.transact([[":db/add", FIRST_USER_EID, RAMOSE_CATALOG_IDENT, "nope"]]),
    ).rejects.toMatchObject({ code: "tx/system" });
    expect(conn.t).toBe(t);
    expect(await resolveCatalogHead(conn.db())).toBeNull();
  });

  test("fromOperation rejects catalog control writes", async () => {
    const conn = await Connection.create();
    await expect(
      conn.transact(
        [[":db/cas", [":db/ident", RAMOSE_CATALOG_IDENT], RAMOSE_CATALOG_HEAD_IDENT, null, 1000]],
        { fromOperation: true },
      ),
    ).rejects.toMatchObject({ code: "tx/system" });
  });

  test("forged membership and catalog control datoms are tx/system", async () => {
    const conn = await Connection.create();
    await publish(conn, await sealUnit());
    const created = await conn.transact([
      { ":db/id": "u", ":user/authId": "ada" },
      { ":db/id": "i", ":issue/title": "Bug", ":issue/owner": "u" },
    ]);
    const issue = created.tempids.i;
    await expect(conn.transact([[":db/add", issue, ":ramose/trait", ":soft"]])).rejects.toMatchObject({
      code: "tx/system",
    });
    await expect(
      conn.transact([[":db/add", issue, RAMOSE_CATALOG_HEAD_IDENT, issue]]),
    ).rejects.toMatchObject({ code: "tx/system" });
    await expect(
      conn.transact([[":db/cas", issue, RAMOSE_CATALOG_UNIT_HASH_IDENT, null, "a".repeat(64)]]),
    ).rejects.toMatchObject({ code: "tx/system" });
  });
});

describe("occupied trait-closure", () => {
  test("first publish on an empty db succeeds", async () => {
    const conn = await Connection.create();
    await publish(conn, await sealUnit());
    expect(await resolveCatalogHead(conn.db())).toBeTypeOf("number");
  });

  test("occupied type + changed trait closure is rejected", async () => {
    const conn = await Connection.create();
    await publish(conn, await sealUnit());
    await conn.transact([
      { ":db/id": "u", ":user/authId": "ada" },
      { ":db/id": "i", ":issue/title": "Bug", ":issue/owner": "u" },
    ]);
    const t = conn.t;
    const v2 = await sealUnit(await evolvedCatalogDescriptor());
    await expect(publish(conn, v2)).rejects.toMatchObject({ code: "tx/occupied-type" });
    expect(conn.t).toBe(t);
    const resolved = await resolve(conn.db());
    expect(resolved.catalog.version).toBe(catalogDescriptor().version);
    expect(conn.db().schema.kindOf(":named")).toBeUndefined();
  });

  test("unoccupied type may evolve traits", async () => {
    const conn = await Connection.create();
    await publish(conn, await sealUnit());
    await conn.transact([{ ":db/id": "u", ":user/authId": "ada" }]);
    const v2 = await sealUnit(await evolvedCatalogDescriptor());
    await publish(conn, v2);
    const resolved = await resolve(conn.db());
    expect(String(resolved.catalog.version)).toBe("2");
    expect(conn.db().schema.transitiveTraits(":issue")).toEqual([":named", ":taggable"]);
    expect(conn.db().schema.kindOf(":named")).toBe(RAMOSE_KIND_TRAIT);
  });

  test("unoccupied type can drop a trait; transitiveTraits and new creates match", async () => {
    const conn = await Connection.create();
    await publish(conn, await sealUnit());
    await conn.transact([{ ":db/id": "u", ":user/authId": "ada" }]);
    const v2 = await sealUnit(await reducedCatalogDescriptor());
    await publish(conn, v2);
    expect(conn.db().schema.composesOf(":issue")).toEqual([]);
    expect(conn.db().schema.transitiveTraits(":issue")).toEqual([]);
    const created = await conn.transact([
      { ":db/id": "i", ":issue/title": "Bug", ":issue/owner": [":user/authId", "ada"] },
    ]);
    const issue = await conn.db().entity(created.tempids.i);
    expect(issue?.[":ramose/type"]).toBe(":issue");
    expect(issue?.[":ramose/trait"]).toBeUndefined();
  });
});

describe("public barrels", () => {
  test("do not export publish / CAS catalog helpers", async () => {
    const [root, db, ir] = await Promise.all([
      import("../../../src/index.ts"),
      import("../../../src/db/index.ts"),
      import("../../../src/internal/authorization/index.ts"),
    ]);
    for (const name of [
      "publishCatalogUnit",
      "assembleCatalogPublicationTx",
      "resolveCatalogHead",
      "resolveInstalledCatalogUnit",
      "schemaTxFromCatalog",
      "catalogCompositionRetracts",
      "compareAndSwapCatalogUnit",
      "installT",
    ] as const) {
      expect(name in root).toBe(false);
      expect(name in db).toBe(false);
    }
    expect("publishCatalogUnit" in ir).toBe(true);
    expect("compareAndSwapCatalogUnit" in ir).toBe(false);
  });
});

describe("schemaTxFromCatalog", () => {
  test("lowers fields and composition into schemaTx-shaped maps", async () => {
    const unit = await sealUnit();
    const tx = schemaTxFromCatalog(unit.catalog);
    expect(tx.filter((op) => ":db/valueType" in op)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ":db/ident": ":user/authId",
          ":db/valueType": ":db.type/string",
          ":db/unique": ":db.unique/identity",
        }),
        expect.objectContaining({
          ":db/ident": ":issue/title",
          ":db/valueType": ":db.type/string",
          ":db/cardinality": ":db.cardinality/one",
        }),
        expect.objectContaining({
          ":db/ident": ":issue/owner",
          ":db/valueType": ":db.type/ref",
        }),
        expect.objectContaining({
          ":db/ident": ":taggable/tags",
          ":db/cardinality": ":db.cardinality/many",
        }),
      ]),
    );
    expect(tx.filter((op) => ":ramose/kind" in op || ":ramose/composes" in op)).toEqual(
      expect.arrayContaining([
        { ":db/ident": ":taggable", ":ramose/kind": RAMOSE_KIND_TRAIT },
        { ":db/ident": ":issue", ":ramose/kind": RAMOSE_KIND_ENTITY },
        { ":db/ident": ":issue", ":ramose/composes": ":taggable" },
        { ":db/ident": ":user", ":ramose/kind": RAMOSE_KIND_ENTITY },
      ]),
    );
    const assembled = assembleCatalogPublicationTx({
      unit,
      expectedHead: null,
      installed: [],
    });
    expect(assembled.at(-1)).toEqual([
      ":db/cas",
      [":db/ident", RAMOSE_CATALOG_IDENT],
      RAMOSE_CATALOG_HEAD_IDENT,
      null,
      "ramose.catalog.unit",
    ]);
  });
});

describe("bootstrap", () => {
  test("fresh db has catalog attrs and the catalog singleton", async () => {
    const conn = await Connection.create();
    const schema = conn.db().schema;
    expect(schema.entid(RAMOSE_CATALOG_IDENT)).toBe(RAMOSE_CATALOG);
    expect(schema.attr(RAMOSE_CATALOG_HEAD_IDENT)?.valueType).toBe(ValueTag.Ref);
    expect(schema.attr(RAMOSE_CATALOG_UNIT_HASH_IDENT)?.unique).toBe("identity");
    expect(schema.attr(RAMOSE_CATALOG_UNIT_BYTES_IDENT)?.valueType).toBe(ValueTag.Bytes);
    const row = await conn.db().entity(RAMOSE_CATALOG);
    expect(row?.[":db/ident"]).toBe(RAMOSE_CATALOG_IDENT);
    expect(row?.[RAMOSE_CATALOG_HEAD_IDENT]).toBeUndefined();
  });
});
