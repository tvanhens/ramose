/**
 * Peer-owned principal provisioning: the upsert shape, when it no-ops, and
 * who stays unresolved.
 */

import { describe, expect, test } from "bun:test";
import { Connection } from "../../../src/internal/core/conn.ts";
import { parsePolicy } from "../../../src/internal/core/policy/ast.ts";
import { anonymousPrincipal } from "../../../src/internal/core/policy/principal.ts";
import { provisionTx, resolveProvisionedEid, roleIdentOf, shouldProvision } from "../../../src/internal/core/policy/provision.ts";
import type { Principal } from "../../../src/internal/core/policy/principal.ts";

const POLICY = parsePolicy({
  version: 2,
  principal: ":user/sub",
  classes: ["member", "admin", "viewer"],
  attrs: {},
  preset: {},
});

const SCHEMA = [
  { ":db/ident": ":user/sub", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/unique": ":db.unique/identity" },
  { ":db/ident": ":user/role", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one" },
];

const user = (sub: string, cls = "member"): Principal => ({
  kind: "user",
  class: cls,
  sub,
  claims: { sub },
  db: "acme",
});

describe("provisionTx", () => {
  test("roleIdentOf is the sibling :ns/role of the principal attr", () => {
    expect(roleIdentOf(":user/sub")).toBe(":user/role");
  });

  test("anonymous and service principals stay unresolved", () => {
    expect(shouldProvision(anonymousPrincipal("acme"))).toBe(false);
    expect(shouldProvision({ kind: "service", class: "admin", claims: {}, db: "acme" })).toBe(false);
  });

  test("no principal attr deployed → nothing to write", async () => {
    const conn = await Connection.create();
    expect(await provisionTx(POLICY, user("ada"), conn.db())).toBeUndefined();
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

  test("without a role attr, a found row is a no-op and a missing row upserts only sub", async () => {
    const conn = await Connection.create();
    await conn.transact([
      { ":db/ident": ":user/sub", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/unique": ":db.unique/identity" },
    ]);
    const create = await provisionTx(POLICY, user("zoe"), conn.db());
    expect(create).toEqual([{ ":user/sub": "zoe" }]);
    await conn.transact(create!);
    expect(await provisionTx(POLICY, user("zoe"), conn.db())).toBeUndefined();
  });
});
