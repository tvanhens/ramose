/**
 * Stage (b): the authoritative write check inside the commit loop.
 *
 * The Worker's ingress pre-check reads a replica that lags the writer, so it is
 * only a latency optimisation — everything here goes straight at the Transactor
 * with the ingress bypassed, which is exactly the case a lagging replica (or a
 * caller that skipped the peer) produces.
 */

import { describe, expect, test } from "bun:test";
import { Index, type Principal, parsePolicy } from "../../../src/internal/core/index.ts";
import { Harness, attribute } from "./harness.ts";

const allow = (expr: unknown) => [{ _tag: "allow", expr }];
const principalOperand = { _tag: "principal" };
const eq = (attr: string, operand: unknown = principalOperand) => ({ _tag: "eq", attr, operand });

const POLICY = parsePolicy({
  version: 1,
  principal: ":user/sub",
  classes: ["member", "admin"],
  superuser: "admin",
  attrs: {
    // owner may write this; only admin may read it — a raw-txData ack would leak it
    ":doc/audit": { read: allow({ _tag: "class", class: "admin" }) },
  },
  ns: {
    doc: {
      read: allow(eq(":doc/owner")),
    },
    user: { read: allow({ _tag: "const", value: true }) },
  },
});

const admin: Principal = { kind: "service", class: "admin", claims: {}, db: "test" };
const member = (sub: string): Principal => ({ kind: "user", class: "member", sub, claims: { sub }, db: "test" });

const SCHEMA = [
  attribute(":user/sub", "string", { ":db/unique": ":db.unique/identity" }),
  attribute(":doc/title", "string"),
  attribute(":doc/owner", "ref"),
  attribute(":doc/audit", "string"),
  attribute(":doc/slug", "string", { ":db/unique": ":db.unique/value" }),
];

/** A policed transactor with schema, two users and a doc Ada owns. */
async function seeded(policy = POLICY) {
  const h = new Harness({ policy });
  await h.transactor.transact(SCHEMA, admin);
  const ack = await h.transactor.transact(
    [
      { ":db/id": "ada", ":user/sub": "user_ada" },
      { ":db/id": "bob", ":user/sub": "user_bob" },
      { ":db/id": "doc", ":doc/title": "Roadmap", ":doc/owner": "ada", ":doc/slug": "roadmap" },
    ],
    admin,
  );
  return { h, eids: ack.tempids };
}

const rejection = async (p: Promise<unknown>) => {
  try {
    await p;
    return undefined;
  } catch (err) {
    return err as { _tag?: string; message: string; code?: string; attr?: string };
  }
};

describe("the commit loop's policy check", () => {
  test("a tx with no principal is rejected when a policy is deployed", async () => {
    const { h, eids } = await seeded();
    const err = await rejection(h.transactor.transact([[":db/add", eids.doc, ":doc/title", "x"]]));
    expect(err?._tag).toBe("TxRejected");
    expect(err?.code).toBe("policy");
  });

  test("a denied op rejects as TxRejected { code: policy } and never reaches the log", async () => {
    const { h, eids } = await seeded();
    const before = h.transactor.t;
    const err = await rejection(h.transactor.transact([[":db/add", eids.doc, ":doc/title", "hacked"]], member("user_bob")));
    expect(err?._tag).toBe("TxRejected");
    expect(err?.code).toBe("policy");
    expect(err?.attr).toBe(":db/tx");
    expect(err?.message).not.toContain("hacked");
    expect(h.transactor.t).toBe(before); // no `t` consumed
  });

  test("an operation-originated tx skips checkTx; a raw member tx does not", async () => {
    const { h, eids } = await seeded();
    const before = h.transactor.t;
    const denied = rejection(h.transactor.transact([[":db/add", eids.doc, ":doc/title", "hacked"]], member("user_bob")));
    const allowed = h.transactor.transact(
      [[":db/add", eids.doc, ":doc/title", "Roadmap v2"]],
      member("user_ada"),
      undefined,
      { fromOperation: true },
    );
    expect((await denied)?.code).toBe("policy");
    expect((await allowed).t).toBe(before + 1);
    expect(h.logTs()).toEqual([1, 2, 3, 4]);
  });

  test("fromOperation is how a named operation lands its tx", async () => {
    const { h, eids } = await seeded();
    const ack = await h.transactor.transact(
      [{ ":db/id": "d", ":doc/title": "Spec", ":doc/owner": eids.ada }],
      member("user_ada"),
      undefined,
      { fromOperation: true },
    );
    const db = h.transactor.connection.db();
    const owner = await db.entity(ack.tempids.d);
    expect((owner as Record<string, unknown>)[":doc/owner"]).toBeDefined();
    expect(
      (
        await h.transactor.transact(
          [[":db/add", ack.tempids.d, ":doc/title", "Spec v2"]],
          member("user_ada"),
          undefined,
          { fromOperation: true },
        )
      ).t,
    ).toBeGreaterThan(0);
  });

  test("a member cannot install or redefine schema on the writer", async () => {
    const { h } = await seeded();
    const before = h.transactor.t;
    const install = [
      {
        ":db/ident": ":junk/one",
        ":db/valueType": ":db.type/string",
        ":db/cardinality": ":db.cardinality/one",
        ":db/optional": true,
      },
    ];
    const redefine = [
      {
        ":db/ident": ":user/sub",
        ":db/valueType": ":db.type/string",
        ":db/unique": ":db.unique/identity",
      },
    ];
    expect((await rejection(h.transactor.transact(install, member("user_bob"))))?.code).toBe("policy");
    expect((await rejection(h.transactor.transact(redefine, member("user_bob"))))?.code).toBe("policy");
    expect(h.transactor.t).toBe(before);
    expect((await h.transactor.transact(install, admin)).t).toBe(before + 1);
  });

  test("admin skips the check entirely", async () => {
    const { h, eids } = await seeded();
    expect((await h.transactor.transact([[":db/add", eids.doc, ":doc/title", "ops rename"]], admin)).t).toBeGreaterThan(0);
  });

  test("a unique conflict under a policy names neither the entity nor the value", async () => {
    const { h } = await seeded();
    const err = await rejection(
      h.transactor.transact([{ ":doc/title": "Copy", ":doc/slug": "roadmap" }], member("user_bob"), undefined, {
        fromOperation: true,
      }),
    );
    expect(err?._tag).toBe("TxRejected");
    expect(err?.code).toBe("tx/unique-conflict");
    expect(err?.message).toBe("unique conflict");
    expect(err?.message).not.toContain("roadmap");
  });

  test("ack.datoms omits facts the writer cannot read (hidden attr)", async () => {
    const { h, eids } = await seeded();
    const ack = await h.transactor.transact(
      [{ ":db/id": "d", ":doc/title": "Spec", ":doc/audit": "hunter2", ":doc/owner": eids.ada }],
      member("user_ada"),
      undefined,
      { fromOperation: true },
    );
    const values = ack.datoms.map((d) => d[3]);
    expect(values).toContain("Spec");
    expect(values).not.toContain("hunter2");
    const db = h.transactor.connection.db();
    const auditId = await db.entid([":db/ident", ":doc/audit"]);
    expect(ack.datoms.some((d) => d[1] === auditId)).toBe(false);
    // the durable log still has the fact — this would fail if ack were raw txData
    const log = await db.datomsArray(Index.EAVT, { a: auditId as number });
    expect(log.some((d) => d.v === "hunter2")).toBe(true);
  });

  test("clientTxId replay is scoped to the writer; a foreign principal does not see their ack", async () => {
    const { h, eids } = await seeded();
    const ada = member("user_ada");
    const bob = member("user_bob");
    const first = await h.transactor.transact(
      [{ ":db/id": "d", ":doc/title": "Ada only", ":doc/audit": "secret-ack", ":doc/owner": eids.ada }],
      ada,
      "c1",
      { fromOperation: true },
    );
    expect(first.datoms.map((d) => d[3])).not.toContain("secret-ack");
    const replay = await h.transactor.transact([{ ":db/id": "other", ":doc/title": "ignored" }], ada, "c1", {
      fromOperation: true,
    });
    expect(replay).toEqual(first);
    expect(h.transactor.t).toBe(first.t);

    const denied = await rejection(h.transactor.transact([[":db/add", eids.doc, ":doc/title", "hacked"]], bob, "c1"));
    expect(denied?.code).toBe("policy");

    const foreign = await h.transactor.transact(
      [{ ":db/id": "bobs", ":doc/title": "Bob doc", ":doc/owner": eids.bob }],
      bob,
      "c1",
      { fromOperation: true },
    );
    expect(foreign.t).toBe(first.t + 1);
    expect(foreign.datoms).not.toEqual(first.datoms);
    expect(foreign.datoms.map((d) => d[3])).toContain("Bob doc");
    expect(JSON.stringify(foreign)).not.toContain("Ada only");
    expect(JSON.stringify(foreign)).not.toContain("secret-ack");
  });

  test("without a policy the conflict is still verbatim (nothing to hide)", async () => {
    const h = new Harness();
    await h.transactor.transact(SCHEMA);
    await h.transactor.transact([{ ":doc/title": "Roadmap", ":doc/slug": "roadmap" }]);
    const err = await rejection(h.transactor.transact([{ ":doc/title": "Copy", ":doc/slug": "roadmap" }]));
    expect(err?.message).toContain("roadmap");
  });
});
