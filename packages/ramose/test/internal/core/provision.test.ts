/**
 * Peer-owned principal provisioning: the upsert shape, when it no-ops, and
 * who stays unresolved.
 */

import { describe, expect, test } from "bun:test";
import { Connection } from "../../../src/internal/core/conn.ts";
import { parsePolicy } from "../../../src/internal/core/policy/ast.ts";
import { anonymousPrincipal } from "../../../src/internal/core/policy/principal.ts";
import { provisionTx, resolveProvisionedEid, roleIdentOf, shouldProvision, siblingIdentOf } from "../../../src/internal/core/policy/provision.ts";
import type { Principal } from "../../../src/internal/core/policy/principal.ts";

const POLICY = parsePolicy({
  version: 2,
  principal: ":user/sub",
  classes: ["member", "admin", "viewer"],
  attrs: {},
});

const SCHEMA = [
  { ":db/ident": ":user/sub", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/unique": ":db.unique/identity", ":db/optional": true },
  { ":db/ident": ":user/role", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/optional": true },
];

const user = (sub: string, cls = "member", attrs?: Record<string, unknown>): Principal => ({
  kind: "user",
  class: cls,
  sub,
  claims: { sub, ...(attrs === undefined ? {} : { attrs }) },
  db: "acme",
});

describe("provisionTx", () => {
  test("roleIdentOf is the sibling :ns/role of the principal attr", () => {
    expect(siblingIdentOf(":user/sub", "name")).toBe(":user/name");
    expect(roleIdentOf(":user/sub")).toBe(":user/role");
  });

  test("anonymous and service principals stay unresolved", () => {
    expect(shouldProvision(anonymousPrincipal("acme"))).toBe(false);
    expect(shouldProvision({ kind: "service", class: "admin", claims: {}, db: "acme" })).toBe(false);
  });

  test("no principal attr deployed → nothing to write", async () => {
    const conn = await Connection.create();
    expect(await provisionTx(POLICY, user("ada"), conn.db())).toBeUndefined();
    expect(await resolveProvisionedEid(POLICY, user("ada"), conn.db())).toBeUndefined();
  });

  test("first session upserts sub + role; re-entry is a no-op; a class change writes role", async () => {
    const conn = await Connection.create();
    await conn.transact(SCHEMA);

    const first = await provisionTx(POLICY, user("ada", "member"), conn.db());
    expect(first).toEqual([{ ":user/sub": "ada", ":user/role": "member" }]);
    await conn.transact(first!);

    const eid = await resolveProvisionedEid(POLICY, user("ada"), conn.db());
    expect(eid).toBeGreaterThan(0);
    expect(await provisionTx(POLICY, user("ada", "member"), conn.db())).toBeUndefined();

    const promoted = await provisionTx(POLICY, user("ada", "admin"), conn.db());
    expect(promoted).toEqual([{ ":user/sub": "ada", ":user/role": "admin" }]);
    await conn.transact(promoted!);
    expect((await conn.db().entity(eid!))![":user/role"]).toBe("admin");
    expect((await conn.db().entity(eid!))![":user/sub"]).toBe("ada");
  });

  test("a strict unique principal attr still resolves; provision does not write", async () => {
    const conn = await Connection.create();
    await conn.transact([
      {
        ":db/ident": ":user/sub",
        ":db/valueType": ":db.type/string",
        ":db/cardinality": ":db.cardinality/one",
        ":db/unique": ":db.unique/value",
        ":db/optional": true,
      },
    ]);
    expect(await provisionTx(POLICY, user("ada"), conn.db())).toBeUndefined();
    expect(await resolveProvisionedEid(POLICY, user("ada"), conn.db())).toBeUndefined();
    await conn.transact([{ ":user/sub": "ada" }]);
    const eid = await resolveProvisionedEid(POLICY, user("ada"), conn.db());
    expect(eid).toBeGreaterThan(0);
    expect(await provisionTx(POLICY, user("ada"), conn.db())).toBeUndefined();
  });

  test("without a role attr, a found row is a no-op and a missing row upserts only sub", async () => {
    const conn = await Connection.create();
    await conn.transact([
      { ":db/ident": ":user/sub", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/unique": ":db.unique/identity", ":db/optional": true },
    ]);
    const create = await provisionTx(POLICY, user("zoe"), conn.db());
    expect(create).toEqual([{ ":user/sub": "zoe" }]);
    await conn.transact(create!);
    expect(await provisionTx(POLICY, user("zoe"), conn.db())).toBeUndefined();
  });

  test("ramose.attrs stamp sibling facts; a rename upserts; reserved keys and type mismatches are skipped", async () => {
    const conn = await Connection.create();
    await conn.transact([
      ...SCHEMA,
      { ":db/ident": ":user/name", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/optional": true },
      { ":db/ident": ":user/email", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/optional": true },
      { ":db/ident": ":user/score", ":db/valueType": ":db.type/long", ":db/cardinality": ":db.cardinality/one", ":db/optional": true },
    ]);

    const first = await provisionTx(
      POLICY,
      user("ada", "member", { name: "Ada", email: "ada@acme.test", role: "viewer", score: "nope", ghost: "x" }),
      conn.db(),
    );
    expect(first).toEqual([
      { ":user/sub": "ada", ":user/role": "member", ":user/name": "Ada", ":user/email": "ada@acme.test" },
    ]);
    await conn.transact(first!);
    expect(await provisionTx(POLICY, user("ada", "member", { name: "Ada", email: "ada@acme.test" }), conn.db())).toBeUndefined();

    const renamed = await provisionTx(POLICY, user("ada", "member", { name: "Ada Lovelace", email: "ada@acme.test" }), conn.db());
    expect(renamed).toEqual([
      { ":user/sub": "ada", ":user/role": "member", ":user/name": "Ada Lovelace", ":user/email": "ada@acme.test" },
    ]);
    await conn.transact(renamed!);
    const eid = await resolveProvisionedEid(POLICY, user("ada"), conn.db());
    expect((await conn.db().entity(eid!))![":user/name"]).toBe("Ada Lovelace");
    expect((await conn.db().entity(eid!))![":user/role"]).toBe("member");
  });
});
