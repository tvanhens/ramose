/**
 * Stage (b): the authoritative write check inside the commit loop.
 *
 * The Worker's ingress pre-check reads a replica that lags the writer, so it is
 * only a latency optimisation — everything here goes straight at the Transactor
 * with the ingress bypassed, which is exactly the case a lagging replica (or a
 * caller that skipped the peer) produces.
 */

import { describe, expect, test } from "bun:test";
import { type Principal, parsePolicy } from "../../../src/internal/core/index.ts";
import { Harness, attribute } from "./harness.ts";

const allow = (expr: unknown) => [{ _tag: "allow", expr }];
const principalOperand = { _tag: "principal" };
const eq = (attr: string, operand: unknown = principalOperand) => ({ _tag: "eq", attr, operand });

const POLICY = parsePolicy({
  version: 1,
  principal: ":user/sub",
  classes: ["member", "admin"],
  ns: {
    doc: {
      read: allow(eq(":doc/owner")),
      create: allow({ _tag: "const", value: true }),
      add: allow(eq(":doc/owner")),
      retract: allow(eq(":doc/owner")),
      retractEntity: allow(eq(":doc/owner")),
    },
    user: { read: allow({ _tag: "const", value: true }) },
  },
  preset: { ":doc/owner": principalOperand },
});

const admin: Principal = { kind: "service", class: "admin", claims: {}, db: "test" };
const member = (sub: string): Principal => ({ kind: "user", class: "member", sub, claims: { sub }, db: "test" });

const SCHEMA = [
  attribute(":user/sub", "string", { ":db/unique": ":db.unique/identity" }),
  attribute(":doc/title", "string"),
  attribute(":doc/owner", "ref"),
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

  test("a denied op rejects as TxRejected { code: policy, attr } and never reaches the log", async () => {
    const { h, eids } = await seeded();
    const before = h.transactor.t;
    const err = await rejection(h.transactor.transact([[":db/add", eids.doc, ":doc/title", "hacked"]], member("user_bob")));
    expect(err?._tag).toBe("TxRejected");
    expect(err?.code).toBe("policy");
    expect(err?.attr).toBe(":doc/title");
    expect(err?.message).not.toContain("hacked");
    expect(h.transactor.t).toBe(before); // no `t` consumed
  });

  test("the owner's own write commits, and the batch's other txs are unaffected by a denial", async () => {
    const { h, eids } = await seeded();
    const before = h.transactor.t;
    const denied = rejection(h.transactor.transact([[":db/add", eids.doc, ":doc/title", "hacked"]], member("user_bob")));
    const allowed = h.transactor.transact([[":db/add", eids.doc, ":doc/title", "Roadmap v2"]], member("user_ada"));
    expect((await denied)?.code).toBe("policy");
    expect((await allowed).t).toBe(before + 1);
    expect(h.logTs()).toEqual([1, 2, 3, 4]);
  });

  test("the writer injects presets and resolves the principal itself when the ingress check was skipped", async () => {
    const { h } = await seeded();
    const ack = await h.transactor.transact([{ ":db/id": "d", ":doc/title": "Spec" }], member("user_ada"));
    const db = h.transactor.connection.db();
    const owner = await db.entity(ack.tempids.d);
    // `:doc/owner` was never in the tx: the peer injected it from the principal
    expect((owner as Record<string, unknown>)[":doc/owner"]).toBeDefined();
    // and now the owner can write to it
    expect((await h.transactor.transact([[":db/add", ack.tempids.d, ":doc/title", "Spec v2"]], member("user_ada"))).t).toBeGreaterThan(0);
  });

  test("admin skips the check entirely", async () => {
    const { h, eids } = await seeded();
    expect((await h.transactor.transact([[":db/add", eids.doc, ":doc/title", "ops rename"]], admin)).t).toBeGreaterThan(0);
  });

  test("a unique conflict under a policy names neither the entity nor the value", async () => {
    const { h } = await seeded();
    const err = await rejection(h.transactor.transact([{ ":doc/title": "Copy", ":doc/slug": "roadmap" }], member("user_bob")));
    expect(err?._tag).toBe("TxRejected");
    expect(err?.code).toBe("tx/unique-conflict");
    expect(err?.message).toBe("unique conflict");
    expect(err?.message).not.toContain("roadmap");
  });

  test("without a policy the conflict is still verbatim (nothing to hide)", async () => {
    const h = new Harness();
    await h.transactor.transact(SCHEMA);
    await h.transactor.transact([{ ":doc/title": "Roadmap", ":doc/slug": "roadmap" }]);
    const err = await rejection(h.transactor.transact([{ ":doc/title": "Copy", ":doc/slug": "roadmap" }]));
    expect(err?.message).toContain("roadmap");
  });
});
