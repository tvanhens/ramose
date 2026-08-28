/**
 * Public deployed-catalog operation execution and `/health` operation listing
 * against a real peer.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { signToken } from "../../packages/ramose/test/sign-local-token.ts";
import { schemaTx } from "../../packages/ramose/src/db/internal.ts";
import {
  CHANGE_IDENTITY_OPERATION_ID,
  CHANGE_IDENTITY_MAP_OPERATION_ID,
  CHANGE_TYPE_OPERATION_ID,
  CLEAR_TITLE_OPERATION_ID,
  CREATE_BOTH_OPERATION_ID,
  CREATE_OPERATION_ID,
  CREATE_THEN_UPDATE_BY_LOOKUP_OPERATION_ID,
  CREATE_WITH_COMPONENT_OPERATION_ID,
  DESTROY_BOUND_OPERATION_ID,
  FORGE_FIXED_OPERATION_ID,
  INSPECT_BOUND_OPERATION_ID,
  MUTATE_CATALOG_OPERATION_ID,
  NATIVE_RUNTIME_OPERATION_ID,
  OP_DATABASE,
  OperationSchema,
  RAW_TEMPID_OPERATION_ID,
  RENAME_OPERATION_ID,
  SEED_MUTABLE_CATALOG_OPERATION_ID,
  SEED_UNDECLARED_CATALOG_OPERATION_ID,
  UNGRANTED_OPERATION_ID,
} from "../local/operation-catalog.ts";
import { json, post, testAdmin, uniqueDb, type LocalUrls } from "../local/fixtures.ts";
import { OPERATION_IDS } from "../local/ops.ts";

export interface OperationsTarget {
  readonly urls: () => LocalUrls;
}

export function registerOperationsContract(target: OperationsTarget): void {
  describe("GET /health lists registered operation ids", () => {
    test("the peer reports the registry it was built with", async () => {
      const { openUrl } = target.urls();
      const { status, body } = await json(openUrl, "/health");
      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.operations).toEqual(OPERATION_IDS);
    });

    test("an empty registry reports an empty list", async () => {
      const { emptyUrl } = target.urls();
      const { body } = await json(emptyUrl, "/health");
      expect(body.operations).toEqual([]);
    });
  });

  describe("POST /db/:name/op", () => {
    let alice: number;
    let aliceIssue: number;
    let bobIssue: number;
    let mutable: number;
    let undeclared: number;
    let token: string;
    let proof: { catalog: string; unitHash: string };

    beforeAll(async () => {
      const { policyUrl } = target.urls();
      const health = await json(policyUrl, "/health");
      proof = health.body.catalogs.find(
        (candidate: { database?: unknown }) => candidate.database === OP_DATABASE,
      );
      expect(proof).toBeDefined();
      const schema = await testAdmin(policyUrl, OP_DATABASE, "/transact", {
        tx: schemaTx(OperationSchema),
      });
      expect(schema.status).toBe(200);
      const seeded = await testAdmin(policyUrl, OP_DATABASE, "/transact", {
        tx: [
          {
            ":db/id": "alice",
            ":ramose/type": ":operation-user",
            ":operation-user/authId": "user_ada",
          },
          {
            ":db/id": "bob",
            ":ramose/type": ":operation-user",
            ":operation-user/authId": "user_bob",
          },
          {
            ":db/id": "alice-issue",
            ":ramose/type": ":operation-issue",
            ":operation-issue/owner": "alice",
            ":operation-issue/title": "Alice original",
          },
          {
            ":db/id": "bob-issue",
            ":ramose/type": ":operation-issue",
            ":operation-issue/owner": "bob",
            ":operation-issue/title": "Bob original",
          },
        ],
      });
      expect(seeded.status).toBe(200);
      alice = seeded.body.tempids.alice;
      aliceIssue = seeded.body.tempids["alice-issue"];
      bobIssue = seeded.body.tempids["bob-issue"];
      token = await signToken(OP_DATABASE, "member", "user_ada");
      const mutableSeed = await json(
        policyUrl,
        `/db/${OP_DATABASE}/op`,
        post({ ...proof, operation: SEED_MUTABLE_CATALOG_OPERATION_ID, input: {} }, token),
      );
      expect(mutableSeed.status).toBe(200);
      const undeclaredSeed = await json(
        policyUrl,
        `/db/${OP_DATABASE}/op`,
        post({ ...proof, operation: SEED_UNDECLARED_CATALOG_OPERATION_ID, input: {} }, token),
      );
      expect(undeclaredSeed.status).toBe(200);
      const mutableRows = await testAdmin(policyUrl, OP_DATABASE, "/query", {
        query: '[:find ?e :where [?e :operation-mutable/title "Mutable"]]',
      }, { "x-ramose-min-t": String(undeclaredSeed.body.t) });
      const undeclaredRows = await testAdmin(policyUrl, OP_DATABASE, "/query", {
        query: '[:find ?e :where [?e :operation-undeclared/title "Undeclared"]]',
      }, { "x-ramose-min-t": String(undeclaredSeed.body.t) });
      mutable = mutableRows.body.result[0][0];
      undeclared = undeclaredRows.body.result[0][0];
    });

    const invokeOperation = (
      url: string,
      operation: unknown,
      targetEid: number | undefined,
      input: unknown,
    ) =>
      json(
        url,
        `/db/${OP_DATABASE}/op`,
        post({
          ...proof,
          operation,
          ...(targetEid === undefined ? {} : { target: targetEid }),
          input,
        }, token),
      );

    test("a statically granted owned operation commits and returns decoded output", async () => {
      const { policyUrl } = target.urls();
      const response = await invokeOperation(
        policyUrl,
        RENAME_OPERATION_ID,
        aliceIssue,
        { title: "Alice renamed" },
      );
      expect(response.status).toBe(200);
      expect(response.body.result).toEqual({ title: "Alice renamed" });
      expect(response.body.t).toBeNumber();

      const current = await testAdmin(policyUrl, OP_DATABASE, "/query", {
        entity: aliceIssue,
      }, { "x-ramose-min-t": String(response.body.t) });
      expect(current.body.entity[":operation-issue/title"]).toBe("Alice renamed");
    });

    test("deployed functions use imports, closures, native syntax, and platform effects", async () => {
      const { policyUrl } = target.urls();
      const response = await invokeOperation(
        policyUrl,
        NATIVE_RUNTIME_OPERATION_ID,
        undefined,
        { values: [" alpha ", "beta", "alpha"] },
      );

      expect(response.status).toBe(200);
      expect(response.body.result).toEqual({
        formatted: "NATIVE:ALPHA:BETA",
        stage: expect.any(String),
        subject: "user_ada",
      });
    });

    test("a static operation needs no target and stamps defaults, fixed values, and type", async () => {
      const { policyUrl } = target.urls();
      const response = await invokeOperation(
        policyUrl,
        CREATE_OPERATION_ID,
        undefined,
        {},
      );
      expect(response.status).toBe(200);
      expect(response.body.result).toEqual({ ok: true });
      const found = await testAdmin(policyUrl, OP_DATABASE, "/query", {
        query:
          '[:find ?e :where [?e :operation-created/title "created by default"]]',
      }, { "x-ramose-min-t": String(response.body.t) });
      const createdEid = found.body.result[0][0];
      const created = await testAdmin(policyUrl, OP_DATABASE, "/query", {
        entity: createdEid,
      }, { "x-ramose-min-t": String(response.body.t) });
      expect(created.body.entity).toMatchObject({
        ":ramose/type": ":operation-created",
        ":operation-created/title": "created by default",
        ":operation-bound/catalog": "authoritative",
      });
    });

    test("direct tempid field writes cannot bypass authoritative creation values", async () => {
      const { policyUrl } = target.urls();
      const rejected = await invokeOperation(
        policyUrl,
        RAW_TEMPID_OPERATION_ID,
        undefined,
        {},
      );
      expect(rejected.status).toBe(400);
      const rows = await testAdmin(policyUrl, OP_DATABASE, "/query", {
        query: '[:find ?e :where [?e :operation-created/title "raw tempid"]]',
      });
      expect(rows.body.result).toEqual([]);
    });

    test("unknown, ungranted, hidden, nonexistent, and wrong-type targets share one denial", async () => {
      const { policyUrl } = target.urls();
      const responses = await Promise.all([
        invokeOperation(
          policyUrl,
          { ...RENAME_OPERATION_ID, localName: "missing-operation" },
          aliceIssue,
          { title: "x" },
        ),
        invokeOperation(policyUrl, UNGRANTED_OPERATION_ID, aliceIssue, { title: "x" }),
        invokeOperation(policyUrl, RENAME_OPERATION_ID, bobIssue, { title: "x" }),
        invokeOperation(policyUrl, RENAME_OPERATION_ID, 999_999, { title: "x" }),
        invokeOperation(policyUrl, RENAME_OPERATION_ID, alice, { title: "x" }),
      ]);
      expect(responses.map((response) => response.status)).toEqual([403, 403, 403, 403, 403]);
      expect(responses.map((response) => response.body)).toEqual([
        responses[0]!.body,
        responses[0]!.body,
        responses[0]!.body,
        responses[0]!.body,
        responses[0]!.body,
      ]);
    });

    test("precommit validation rejects principal identity writes without committing", async () => {
      const { policyUrl } = target.urls();
      const rejected = await invokeOperation(
        policyUrl,
        CHANGE_IDENTITY_OPERATION_ID,
        alice,
        { authId: "hijacked" },
      );
      expect(rejected.status).toBe(400);

      const stillAuthorized = await invokeOperation(
        policyUrl,
        RENAME_OPERATION_ID,
        aliceIssue,
        { title: "Still Alice" },
      );
      expect(stillAuthorized.status).toBe(200);
      const principal = await testAdmin(policyUrl, OP_DATABASE, "/query", {
        entity: alice,
      }, { "x-ramose-min-t": String(stillAuthorized.body.t) });
      expect(principal.body.entity[":operation-user/authId"]).toBe("user_ada");
    });

    test("map writes cannot mutate principal identity", async () => {
      const { policyUrl } = target.urls();
      const rejected = await invokeOperation(
        policyUrl,
        CHANGE_IDENTITY_MAP_OPERATION_ID,
        alice,
        { authId: "map-hijacked" },
      );
      expect(rejected.status).toBe(400);

      const principal = await testAdmin(policyUrl, OP_DATABASE, "/query", {
        entity: alice,
      });
      expect(principal.body.entity[":operation-user/authId"]).toBe("user_ada");
    });

    test("operation bodies cannot supply engine-owned fixed fields", async () => {
      const { policyUrl } = target.urls();
      const rejected = await invokeOperation(
        policyUrl,
        FORGE_FIXED_OPERATION_ID,
        undefined,
        {},
      );
      expect(rejected.status).toBe(400);

      const stillUsable = await invokeOperation(
        policyUrl,
        CREATE_OPERATION_ID,
        undefined,
        {},
      );
      expect(stillUsable.status).toBe(200);
    });

    test("operation bodies cannot mutate the protected canonical type", async () => {
      const { policyUrl } = target.urls();
      const rejected = await invokeOperation(
        policyUrl,
        CHANGE_TYPE_OPERATION_ID,
        aliceIssue,
        {},
      );
      expect(rejected.status).toBe(409);

      const unchanged = await testAdmin(policyUrl, OP_DATABASE, "/query", {
        entity: aliceIssue,
      });
      expect(unchanged.body.entity[":ramose/type"]).toBe(":operation-issue");
    });

    test("a trait-owned operation accepts only a compatible visible composer", async () => {
      const { policyUrl } = target.urls();
      const created = await invokeOperation(
        policyUrl,
        CREATE_OPERATION_ID,
        undefined,
        {},
      );
      expect(created.status).toBe(200);
      const rows = await testAdmin(policyUrl, OP_DATABASE, "/query", {
        query: '[:find ?e :where [?e :ramose/type ":operation-created"]]',
      }, { "x-ramose-min-t": String(created.body.t) });
      const createdEid = rows.body.result[0][0];

      const accepted = await invokeOperation(
        policyUrl,
        INSPECT_BOUND_OPERATION_ID,
        createdEid,
        {},
      );
      const wrongType = await invokeOperation(
        policyUrl,
        INSPECT_BOUND_OPERATION_ID,
        aliceIssue,
        {},
      );
      expect(accepted.status).toBe(200);
      expect(accepted.body.result).toEqual({ ok: true });
      expect(wrongType.status).toBe(403);
    });

    test("the definition overload supports a valueless field removal", async () => {
      const { policyUrl } = target.urls();
      const removed = await invokeOperation(
        policyUrl,
        CLEAR_TITLE_OPERATION_ID,
        aliceIssue,
        {},
      );
      expect(removed.status).toBe(200);
      const issue = await testAdmin(policyUrl, OP_DATABASE, "/query", {
        entity: aliceIssue,
      }, { "x-ramose-min-t": String(removed.body.t) });
      expect(issue.body.entity[":operation-issue/title"]).toBeUndefined();
    });

    test("fixed bindings validate against each created concrete type", async () => {
      const { policyUrl } = target.urls();
      const created = await invokeOperation(
        policyUrl,
        CREATE_BOTH_OPERATION_ID,
        undefined,
        {},
      );
      expect(created.status).toBe(200);
      const rows = await testAdmin(policyUrl, OP_DATABASE, "/query", {
        query: "[:find ?e ?type ?catalog :where [?e :ramose/type ?type] [?e :operation-bound/catalog ?catalog]]",
      }, { "x-ramose-min-t": String(created.body.t) });
      expect(rows.body.result).toContainEqual([
        expect.any(Number),
        ":operation-created",
        "authoritative",
      ]);
      expect(rows.body.result).toContainEqual([
        expect.any(Number),
        ":operation-created-other",
        "other-authoritative",
      ]);
    });

    test("a lookup can address a unique row created earlier in the operation", async () => {
      const { policyUrl } = target.urls();
      const response = await invokeOperation(
        policyUrl,
        CREATE_THEN_UPDATE_BY_LOOKUP_OPERATION_ID,
        undefined,
        {},
      );
      expect(response.status).toBe(200);
      expect(response.body.result).toEqual({ ok: true });

      const rows = await testAdmin(policyUrl, OP_DATABASE, "/query", {
        query: '[:find ?e :where [?e :operation-component/value "lookup-after"]]',
      }, { "x-ramose-min-t": String(response.body.t) });
      expect(rows.body.result).toHaveLength(1);
    });

    test("field writes use the concrete row type for fixed and write-scope checks", async () => {
      const { policyUrl } = target.urls();
      const accepted = await invokeOperation(
        policyUrl,
        MUTATE_CATALOG_OPERATION_ID,
        undefined,
        { id: mutable, catalog: "changed" },
      );
      expect(accepted.status).toBe(200);
      const rejected = await invokeOperation(
        policyUrl,
        MUTATE_CATALOG_OPERATION_ID,
        undefined,
        { id: undeclared, catalog: "escaped" },
      );
      expect(rejected.status).toBe(400);

      const mutableRow = await testAdmin(policyUrl, OP_DATABASE, "/query", {
        entity: mutable,
      }, { "x-ramose-min-t": String(accepted.body.t) });
      const undeclaredRow = await testAdmin(policyUrl, OP_DATABASE, "/query", {
        entity: undeclared,
      }, { "x-ramose-min-t": String(accepted.body.t) });
      expect(mutableRow.body.entity[":operation-bound/catalog"]).toBe("changed");
      expect(undeclaredRow.body.entity[":operation-bound/catalog"]).toBe("initial");
    });

    test("whole-entity deletion may retract engine-owned fixed bindings", async () => {
      const { policyUrl } = target.urls();
      const created = await invokeOperation(
        policyUrl,
        CREATE_WITH_COMPONENT_OPERATION_ID,
        undefined,
        {},
      );
      const rows = await testAdmin(policyUrl, OP_DATABASE, "/query", {
        query: "[:find ?e ?child :where [?e :operation-created/child ?child]]",
      }, { "x-ramose-min-t": String(created.body.t) });
      const createdEid = rows.body.result[0][0];
      const childEid = rows.body.result[0][1];
      const destroyed = await invokeOperation(
        policyUrl,
        DESTROY_BOUND_OPERATION_ID,
        createdEid,
        {},
      );
      expect(destroyed.status).toBe(200);
      const missing = await testAdmin(policyUrl, OP_DATABASE, "/query", {
        entity: createdEid,
      }, { "x-ramose-min-t": String(destroyed.body.t) });
      const missingChild = await testAdmin(policyUrl, OP_DATABASE, "/query", {
        entity: childEid,
      }, { "x-ramose-min-t": String(destroyed.body.t) });
      expect(missing.body.entity).toBeNull();
      expect(missingChild.body.entity).toBeNull();
    });

    test("raw application transactions remain closed", async () => {
      const { policyUrl } = target.urls();
      const response = await json(
        policyUrl,
        `/db/${OP_DATABASE}/transact`,
        post({ tx: [{ ":operation-issue/title": "bypass" }] }, token),
      );
      expect(response.status).toBe(401);
    });

    test("the old name-based operation alias remains closed", async () => {
      const { openUrl, policyUrl } = target.urls();
      const db = uniqueDb("movies");
      const unknown = await json(openUrl, `/db/${db}/op`, post({ name: "nope", input: {} }));
      expect(unknown.status).toBe(401);
      const registered = await json(policyUrl, `/db/${db}/op`, post({ name: OPERATION_IDS[0], input: {} }));
      expect(registered.status).toBe(401);
    });
  });
}
