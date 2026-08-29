import { beforeAll, describe, expect, test } from "bun:test";
import { signToken } from "../../packages/ramose/test/sign-local-token.ts";
import { schemaTx } from "../../packages/ramose/src/db/internal.ts";
import { json, testAdmin, type LocalUrls } from "./fixtures.ts";
import {
  OperationSchema,
} from "./operation-catalog.ts";
import { loadOperationProof, operationProof } from "./operation-proof.ts";

const invoke = async (
  base: string,
  database: string,
  token: string,
  operation: {
    readonly owner: { readonly kind: "entity" | "trait"; readonly name: string };
    readonly localName: string;
  },
  input: unknown,
  target?: number,
) => json(base, `/db/${database}/op`, {
  method: "POST",
  token,
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    ...operationProof,
    operation,
    input,
    ...(target === undefined ? {} : { target }),
  }),
});

const install = async (base: string, database: string) => {
  const response = await testAdmin(base, database, "/transact", {
    tx: schemaTx(OperationSchema),
  });
  expect(response.status).toBe(200);
};

const waitForCheckpoint = async (
  base: string,
  database: string,
  scope: "worker" | "transactor",
  name: string,
): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt++) {
    const status = await testAdmin(base, database, "/checkpoint", {
      scope,
      action: "status",
    });
    if (status.body.checkpoints?.[name]?.pending === true) return;
    await Bun.sleep(25);
  }
  throw new Error(`operation did not reach the ${scope} ${name} checkpoint`);
};

export const registerNativeOperations = (ctx: { urls: () => LocalUrls }) => {
  describe("native deployed operations", () => {
    beforeAll(() => loadOperationProof(ctx.urls().nativeOperationsUrl));

    test("static operation commits through the real Worker/Transactor/R2 topology", async () => {
      const base = ctx.urls().nativeOperationsUrl;
      const database = "operations-static";
      await install(base, database);
      const token = await signToken(database, "member");
      const created = await invoke(base, database, token, {
        owner: { kind: "entity", name: "nativeItem" },
        localName: "create",
      }, { title: "Created" });
      expect(created.status).toBe(200);
      expect(created.body).toEqual({
        result: { id: expect.any(Number) },
      });
      expect(Object.hasOwn(created.body, "t")).toBe(false);
      expect(created.res.headers.get("x-ramose-basis-t")).toBeNull();

      // Test-only instrumentation may observe the internal basis to fence the
      // real Replica read; the public operation response above may not.
      const basis = await testAdmin(base, database, "/basis", { action: "fetch" }, {
        "x-ramose-cache-basis": "0",
      });
      expect(basis.status).toBe(200);
      const committedT = basis.body.basis.t as number;

      const readBack = await json(base, `/db/${database}/entity/${created.body.result.id}`, {
        token,
        headers: {
          "x-ramose-catalog": operationProof.catalog,
          "x-ramose-unit-hash": operationProof.unitHash,
          "x-ramose-min-t": String(committedT),
        },
      });
      expect(readBack.status).toBe(200);
      expect(readBack.body.result).toMatchObject({
        ":ramose/type": ":nativeItem",
        ":nativeItem/title": "Created",
        ":nativeItem/state": "new",
      });

      const transportTag = await invoke(base, database, token, {
        owner: { kind: "entity", name: "nativeItem" },
        localName: "returnTransportTag",
      }, {});
      expect(transportTag.status).toBe(200);
      expect(transportTag.body).toEqual({
        result: { $inst: "application-value" },
      });

      const transportTagInput = await invoke(base, database, token, {
        owner: { kind: "entity", name: "nativeItem" },
        localName: "echoTransportTagInput",
      }, { $inst: "application-input" });
      expect(transportTagInput.status).toBe(200);
      expect(transportTagInput.body).toEqual({
        result: { $inst: "application-input" },
      });

      const exactToken = await signToken(database, "member", "user_wire", {
        transportClaim: "claim-owned",
      });
      const exactInput = {
        tagged: { vt: 3, v: "input-owned" },
        ownProto: JSON.parse('{"__proto__":"input-owned","kept":true}'),
      };
      const exactWire = await invoke(base, database, exactToken, {
        owner: { kind: "entity", name: "nativeItem" },
        localName: "echoExactWireValues",
      }, exactInput);
      expect(exactWire.status).toBe(200);
      const exactResult = exactWire.body.result as Record<string, unknown>;
      expect((exactResult.input as Record<string, unknown>).tagged).toEqual({
        vt: 3,
        v: "input-owned",
      });
      expect(exactResult.claim).toBe("claim-owned");
      expect(exactResult.tagged).toEqual({ vt: 1, v: "output-owned" });
      const inputProto = (exactResult.input as Record<string, unknown>).ownProto as Record<string, unknown>;
      expect(Object.hasOwn(inputProto, "__proto__")).toBe(true);
      expect(inputProto.__proto__).toBe("input-owned");
      const outputProto = exactResult.ownProto as Record<string, unknown>;
      expect(Object.hasOwn(outputProto, "__proto__")).toBe(true);
      expect(outputProto.__proto__).toBe("output-owned");
      expect(outputProto.kept).toBe(true);
    });

    test("targeted operation requires both its grant and filtered target visibility", async () => {
      const base = ctx.urls().nativeOperationsUrl;
      const database = "operations-targeted";
      await install(base, database);
      const member = await signToken(database, "member");
      const item = await invoke(base, database, member, {
        owner: { kind: "entity", name: "nativeItem" },
        localName: "create",
      }, { title: "Before" });
      expect(item.status).toBe(200);
      const renamed = await invoke(base, database, member, {
        owner: { kind: "entity", name: "nativeItem" },
        localName: "rename",
      }, { title: "After" }, item.body.result.id);
      expect(renamed.status).toBe(200);
      expect(renamed.body.result).toEqual({ id: item.body.result.id, title: "After" });

      const reader = await signToken(database, "reader");
      const readableButNotGranted = await invoke(base, database, reader, {
        owner: { kind: "entity", name: "nativeItem" },
        localName: "rename",
      }, { title: "Denied" }, item.body.result.id);
      expect(readableButNotGranted.status).toBe(403);

      const operator = await signToken(database, "operator");
      const grantedButHidden = await invoke(base, database, operator, {
        owner: { kind: "entity", name: "nativeItem" },
        localName: "rename",
      }, { title: "Denied" }, item.body.result.id);
      const nonexistent = await invoke(base, database, member, {
        owner: { kind: "entity", name: "nativeItem" },
        localName: "rename",
      }, { title: "Denied" }, 999_999);
      expect(grantedButHidden.status).toBe(403);
      expect(nonexistent.status).toBe(403);
      expect(grantedButHidden.body).toEqual(nonexistent.body);

      const invalidInput = await invoke(base, database, member, {
        owner: { kind: "entity", name: "nativeItem" },
        localName: "rename",
      }, { title: 42 }, item.body.result.id);
      expect(invalidInput.status).toBe(400);
      expect(invalidInput.res.headers.get("access-control-allow-origin")).toBe("*");
      expect(invalidInput.res.headers.get("access-control-allow-methods")).toContain("POST");
    });

    test("an operation expiring at the real DO commit fence fails atomically", async () => {
      const base = ctx.urls().nativeOperationsUrl;
      const database = "operations-expiry";
      await install(base, database);
      const exp = Math.floor(Date.now() / 1_000) + 4;
      const token = await signToken(database, "member", "user_ada", undefined, { exp });
      const armed = await testAdmin(base, database, "/checkpoint", {
        scope: "transactor",
        action: "arm-wait",
        name: "transactor.commit",
      });
      expect(armed.status).toBe(200);

      const pending = invoke(base, database, token, {
        owner: { kind: "entity", name: "nativeItem" },
        localName: "create",
      }, { title: "Expired" });
      let released = false;
      try {
        await waitForCheckpoint(base, database, "transactor", "transactor.commit");
        const untilExpiry = exp * 1_000 - Date.now() + 25;
        if (untilExpiry > 0) await Bun.sleep(untilExpiry);
        // Releasing lets the expiry fence abort this DO. The admin request may
        // therefore observe that same abort (500) even though it released the
        // real checkpoint, so the operation result is the authoritative check.
        await testAdmin(base, database, "/checkpoint", {
          scope: "transactor",
          action: "release",
          name: "transactor.commit",
        });
        released = true;
      } finally {
        if (!released) {
          await testAdmin(base, database, "/checkpoint", {
            scope: "transactor",
            action: "release",
            name: "transactor.commit",
          });
        }
      }

      const expired = await pending;
      expect(expired.status).toBe(500);
      expect(expired.body).toEqual({ error: "internal error" });
      expect(Object.hasOwn(expired.body, "t")).toBe(false);
      expect(expired.res.headers.get("x-ramose-basis-t")).toBeNull();

      const absent = await testAdmin(base, database, "/query", {
        query: '[:find ?e :where [?e :nativeItem/title "Expired"]]',
      });
      expect(absent.status).toBe(200);
      expect(absent.body.result).toEqual([]);
    });

    test("an operation expiring after the real DO acknowledgement commits but returns no result", async () => {
      const base = ctx.urls().nativeOperationsUrl;
      const database = "operations-response-expiry";
      await install(base, database);
      // Initialize the real Replica before arming module-isolate checkpoint
      // state. DO constructors intentionally reset stale test hooks.
      const warmed = await testAdmin(base, database, "/query", {
        query: "[:find ?e :where [?e :nativeItem/title ?title]]",
      });
      expect(warmed.status).toBe(200);
      const exp = Math.floor(Date.now() / 1_000) + 4;
      const token = await signToken(database, "member", "user_ada", undefined, { exp });
      const armed = await testAdmin(base, database, "/checkpoint", {
        scope: "worker",
        action: "arm-wait",
        name: "operation.response",
        // The delay starts only once the real Worker boundary is reached, so
        // this releases the same isolate-local arm after the JWT is exact-expired.
        releaseAfterMs: exp * 1_000 - Date.now() + 25,
      });
      expect(armed.status).toBe(200);

      const title = "Committed before response expiry";
      const pending = invoke(base, database, token, {
        owner: { kind: "entity", name: "nativeItem" },
        localName: "create",
      }, { title });
      await waitForCheckpoint(base, database, "worker", "operation.response");

      // Reaching the Worker checkpoint means the real Transactor returned its
      // acknowledgement. Fence a real Replica read to that committed basis
      // while the public operation response remains parked.
      const basis = await testAdmin(base, database, "/basis", { action: "fetch" }, {
        "x-ramose-cache-basis": "0",
      });
      expect(basis.status).toBe(200);
      const committedT = basis.body.basis.t as number;
      const committed = await testAdmin(base, database, "/query", {
        query: `[:find ?e :where [?e :nativeItem/title ${JSON.stringify(title)}]]`,
      }, {
        "x-ramose-min-t": String(committedT),
      });
      expect(committed.status).toBe(200);
      expect(committed.body.result).toEqual([[expect.any(Number)]]);

      const expired = await pending;
      expect(Date.now()).toBeGreaterThanOrEqual(exp * 1_000);
      expect(expired.status).toBe(403);
      expect(expired.body).toEqual({ error: "unauthorized" });
      expect(Object.hasOwn(expired.body, "result")).toBe(false);
      expect(Object.hasOwn(expired.body, "t")).toBe(false);

      const persisted = await testAdmin(base, database, "/query", {
        query: `[:find ?e :where [?e :nativeItem/title ${JSON.stringify(title)}]]`,
      });
      expect(persisted.status).toBe(200);
      expect(persisted.body.result).toEqual([[expect.any(Number)]]);
    });

    test("trusted native code reads and mutates application data hidden from its caller", async () => {
      const base = ctx.urls().nativeOperationsUrl;
      const database = "operations-trusted";
      await install(base, database);
      const member = await signToken(database, "member");
      const created = await invoke(base, database, member, {
        owner: { kind: "entity", name: "nativeOther" },
        localName: "create",
      }, { name: "Hidden" });
      expect(created.status).toBe(200);
      const hiddenId = created.body.result.id as number;

      const ordinaryRead = await json(base, `/db/${database}/entity/${hiddenId}`, {
        token: member,
        headers: {
          "x-ramose-catalog": operationProof.catalog,
          "x-ramose-unit-hash": operationProof.unitHash,
        },
      });
      expect(ordinaryRead.status).toBe(200);
      expect(JSON.stringify(ordinaryRead.body)).not.toContain("Hidden");

      const trusted = await invoke(base, database, member, {
        owner: { kind: "entity", name: "nativeItem" },
        localName: "deleteHiddenOther",
      }, { id: hiddenId });
      expect(trusted.status).toBe(200);
      expect(trusted.body).toEqual({ result: { name: "HIDDEN" } });

      const absent = await testAdmin(base, database, "/query", {
        query: `[:find ?e :where [?e :nativeOther/name "Hidden"]]`,
      });
      expect(absent.status).toBe(200);
      expect(absent.body.result).toEqual([]);
    });

    test("raw writes and stale unit proofs remain closed", async () => {
      const base = ctx.urls().nativeOperationsUrl;
      const database = "operations-denials";
      await install(base, database);
      const token = await signToken(database, "member");
      const raw = await json(base, `/db/${database}/transact`, {
        method: "POST",
        token,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tx: [{ ":nativeItem/title": "raw" }] }),
      });
      expect(raw.status).toBe(401);

      const firstUnique = await invoke(base, database, token, {
        owner: { kind: "entity", name: "nativeOther" },
        localName: "create",
      }, { name: "Conflict" });
      expect(firstUnique.status).toBe(200);
      const conflict = await invoke(base, database, token, {
        owner: { kind: "entity", name: "nativeOther" },
        localName: "create",
      }, { name: "Conflict" });
      expect(conflict.status).toBe(409);
      expect(conflict.body).toEqual({ error: "request rejected" });
      expect(JSON.stringify(conflict.body)).not.toContain(String(firstUnique.body.result.id));

      const crashed = await invoke(base, database, token, {
        owner: { kind: "entity", name: "nativeItem" },
        localName: "crash",
      }, {});
      expect(crashed.status).toBe(500);
      expect(crashed.body.error).toBe("internal error");
      expect(JSON.stringify(crashed.body)).not.toContain("secret@internal");

      const invalidInput = await invoke(base, database, token, {
        owner: { kind: "entity", name: "nativeItem" },
        localName: "inputCrash",
      }, { value: 42 });
      expect(invalidInput.status).toBe(400);
      expect(invalidInput.body).toEqual({ error: "invalid request" });

      const inputCrashed = await invoke(base, database, token, {
        owner: { kind: "entity", name: "nativeItem" },
        localName: "inputCrash",
      }, { value: "explode" });
      expect(inputCrashed.status).toBe(500);
      expect(inputCrashed.body).toEqual({ error: "internal error" });
      expect(JSON.stringify(inputCrashed.body)).not.toContain("input-secret@internal");

      const item = await invoke(base, database, token, {
        owner: { kind: "entity", name: "nativeItem" },
        localName: "create",
      }, { title: "Field codec" });
      expect(item.status).toBe(200);

      const invalidField = await invoke(base, database, token, {
        owner: { kind: "entity", name: "nativeItem" },
        localName: "fieldCodec",
      }, { kind: "invalid" }, item.body.result.id);
      expect(invalidField.status).toBe(400);
      expect(invalidField.body).toEqual({ error: "invalid request" });

      const fieldCrashed = await invoke(base, database, token, {
        owner: { kind: "entity", name: "nativeItem" },
        localName: "fieldCodec",
      }, { kind: "crash" }, item.body.result.id);
      expect(fieldCrashed.status).toBe(500);
      expect(fieldCrashed.body).toEqual({ error: "internal error" });
      expect(JSON.stringify(fieldCrashed.body)).not.toContain("field-secret@internal");

      const beforeRefCodec = await testAdmin(base, database, "/query", {
        query: "[:find ?e :where [?e :nativeItem/title ?title]]",
      });
      expect(beforeRefCodec.status).toBe(200);
      const invalidRef = await invoke(base, database, token, {
        owner: { kind: "entity", name: "nativeItem" },
        localName: "refFieldCodec",
      }, { kind: "invalid", id: firstUnique.body.result.id }, item.body.result.id);
      expect(invalidRef.status).toBe(400);
      expect(invalidRef.body).toEqual({ error: "invalid request" });

      const refCrashed = await invoke(base, database, token, {
        owner: { kind: "entity", name: "nativeItem" },
        localName: "refFieldCodec",
      }, { kind: "crash", id: firstUnique.body.result.id }, item.body.result.id);
      expect(refCrashed.status).toBe(500);
      expect(refCrashed.body).toEqual({ error: "internal error" });
      expect(JSON.stringify(refCrashed.body)).not.toContain("ref-secret@internal");
      const afterRefCodec = await testAdmin(base, database, "/query", {
        query: "[:find ?e :where [?e :nativeItem/title ?title]]",
      });
      expect(afterRefCodec.status).toBe(200);
      expect(afterRefCodec.body.t).toBe(beforeRefCodec.body.t);

      const rejected = await invoke(base, database, token, {
        owner: { kind: "entity", name: "nativeItem" },
        localName: "reject",
      }, {});
      expect(rejected.status).toBe(409);
      expect(rejected.body).toEqual({
        error: "domain refused",
        tag: "OperationRejected",
        message: "domain refused",
        operation: "nativeItem/reject",
        step: "rule",
        reason: "intentional",
      });

      const stale = await json(base, `/db/${database}/op`, {
        method: "POST",
        token,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...operationProof,
          unitHash: "0".repeat(64),
          operation: {
            owner: { kind: "entity", name: "nativeItem" },
            localName: "create",
          },
          input: { title: "stale" },
        }),
      });
      const missingOperation = await invoke(base, database, token, {
        owner: { kind: "entity", name: "nativeItem" },
        localName: "missing",
      }, {});
      expect(stale.status).toBe(403);
      expect(missingOperation.status).toBe(403);
      expect(stale.body).toEqual(missingOperation.body);
    });
  });
};
