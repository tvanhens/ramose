import { describe, expect, test } from "bun:test";
import { Connection } from "../../src/internal/core/conn.ts";
import type { Principal } from "../../src/worker/auth.ts";
import {
  PRINCIPAL_HEADER,
  parsePrincipalHeader,
  planOf,
  sessionPrincipalExpired,
} from "../../src/worker/session.ts";
import { decideSessionTx } from "../../src/worker/session-sync.ts";

describe("planOf: frame to sub-request", () => {
  test("read frames preserve payload options and read fences", () => {
    const query = planOf({
      id: 1,
      op: "q",
      query: "[:find ?e :where [?e :name]]",
      inputs: [7],
      asOf: 3,
      history: true,
      explain: true,
      minT: 12,
    });
    expect(query).toMatchObject({
      id: 1,
      op: "q",
      rest: "/query",
      method: "POST",
      headers: { "content-type": "application/json", "x-ramose-min-t": "12" },
    });
    expect(JSON.parse("body" in query && query.body !== undefined ? query.body : "null"))
      .toEqual({
        query: "[:find ?e :where [?e :name]]",
        inputs: [7],
        asOf: 3,
        history: true,
        explain: true,
      });

    expect(planOf({ id: 2, op: "pull", eid: 7, pattern: ["*"], minT: 0 }))
      .toMatchObject({ rest: "/pull", method: "POST", headers: { "x-ramose-min-t": "0" } });
    expect(planOf({ id: 3, op: "entity", eid: 42, asOf: 9 }))
      .toMatchObject({ rest: "/entity/42?asOf=9", method: "GET" });
    expect(planOf({ id: 4, op: "info" })).toEqual({
      id: 4,
      op: "info",
      rest: "/info",
      method: "GET",
      headers: {},
    });
  });

  test("write frames preserve replay identifiers", () => {
    const transact = planOf({
      id: 1,
      op: "transact",
      tx: [{ ":db/id": -1 }],
      clientTxId: "tx-1",
    });
    expect(transact).toMatchObject({ rest: "/transact", method: "POST" });
    expect(JSON.parse("body" in transact && transact.body !== undefined ? transact.body : "null"))
      .toEqual({ tx: [{ ":db/id": -1 }], clientTxId: "tx-1" });

    const operation = planOf({
      id: 2,
      op: "operation",
      name: "issue/move",
      entity: 1001,
      input: { status: "done" },
      clientOpId: "op-1",
    });
    expect(operation).toMatchObject({ rest: "/op", method: "POST" });
    expect(JSON.parse("body" in operation && operation.body !== undefined ? operation.body : "null"))
      .toEqual({
        name: "issue/move",
        entity: 1001,
        input: { status: "done" },
        clientOpId: "op-1",
      });
  });

  test("malformed frames fail as pure plan decisions", () => {
    expect(planOf({ op: "info" })).toEqual({
      id: undefined,
      error: "frame.id must be a number",
    });
    expect(planOf([1, 2])).toEqual({ id: undefined, error: "frame must be an object" });
    expect(planOf({ id: 1, op: "nope" })).toEqual({ id: 1, error: "unknown op: nope" });
    expect(planOf({ id: 2, op: "q" })).toEqual({ id: 2, error: "q frame needs query" });
    expect(planOf({ id: 3, op: "entity", eid: "x" })).toEqual({
      id: 3,
      error: "entity frame needs eid: number",
    });
  });
});

describe("session identity decisions", () => {
  const principal = (exp?: number): Principal => ({
    kind: "user",
    class: "member",
    sub: "ada",
    claims: { sub: "ada", ...(exp === undefined ? {} : { exp }) },
  });

  test("the trusted principal header parser rejects malformed values", () => {
    const ada = principal();
    expect(PRINCIPAL_HEADER).toBe("x-ramose-principal");
    expect(parsePrincipalHeader(JSON.stringify(ada))).toEqual(ada);
    expect(parsePrincipalHeader(null)).toBeUndefined();
    expect(parsePrincipalHeader("")).toBeUndefined();
    expect(parsePrincipalHeader("{")).toBeUndefined();
    expect(parsePrincipalHeader(JSON.stringify({ class: "member" }))).toBeUndefined();
  });

  test("expiry is a pure boundary decision", () => {
    expect(sessionPrincipalExpired(principal(), 10_000)).toBe(false);
    expect(sessionPrincipalExpired(principal(10), 9_999)).toBe(false);
    expect(sessionPrincipalExpired(principal(10), 10_000)).toBe(true);
  });
});

describe("decideSessionTx", () => {
  test("general replication remains fail-closed after leased live queries", async () => {
    const conn = await Connection.create();
    const decision = await decideSessionTx({
      datoms: [],
      ruleDbAfter: conn.db(),
      ruleDbBefore: conn.db(),
    });
    expect(decision).toEqual({ kind: "skip" });
  });
});
