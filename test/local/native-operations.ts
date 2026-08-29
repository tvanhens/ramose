import { describe, expect, test } from "bun:test";
import { signToken } from "../../packages/ramose/test/sign-local-token.ts";
import { schemaTx } from "../../packages/ramose/src/db/internal.ts";
import { json, testAdmin, type LocalUrls } from "./fixtures.ts";
import {
  OperationSchema,
  operationProof,
} from "./operation-catalog.ts";

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

const waitForCommitCheckpoint = async (
  base: string,
  database: string,
): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt++) {
    const status = await testAdmin(base, database, "/checkpoint", {
      scope: "transactor",
      action: "status",
    });
    if (status.body.checkpoints?.["transactor.commit"]?.pending === true) return;
    await Bun.sleep(25);
  }
  throw new Error("operation did not reach the transactor commit checkpoint");
};

export const registerNativeOperations = (ctx: { urls: () => LocalUrls }) => {
  describe("native deployed operations", () => {
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
        await waitForCommitCheckpoint(base, database);
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
      expect(expired.body).toEqual({ error: "operation execution failed" });
      expect(Object.hasOwn(expired.body, "t")).toBe(false);
      expect(expired.res.headers.get("x-ramose-basis-t")).toBeNull();

      const absent = await testAdmin(base, database, "/query", {
        query: '[:find ?e :where [?e :nativeItem/title "Expired"]]',
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

      const crashed = await invoke(base, database, token, {
        owner: { kind: "entity", name: "nativeItem" },
        localName: "crash",
      }, {});
      expect(crashed.status).toBe(500);
      expect(crashed.body.error).toBe("operation execution failed");
      expect(JSON.stringify(crashed.body)).not.toContain("secret@internal");

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
