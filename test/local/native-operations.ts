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
        t: expect.any(Number),
      });
      expect(created.res.headers.get("x-ramose-basis-t")).toBe(String(created.body.t));

      const readBack = await json(base, `/db/${database}/entity/${created.body.result.id}`, {
        token,
        headers: {
          "x-ramose-catalog": operationProof.catalog,
          "x-ramose-unit-hash": operationProof.unitHash,
          "x-ramose-min-t": String(created.body.t),
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
      expect(stale.status).toBe(401);
    });
  });
};
