import { beforeAll, describe, expect, test } from "bun:test";
import { schemaTx } from "../../packages/ramose/src/db/internal.ts";
import { signToken } from "../../packages/ramose/test/sign-local-token.ts";
import { json, testAdmin, type LocalUrls } from "./fixtures.ts";
import { OperationSchema } from "./operation-catalog.ts";

const MCP_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

let rpcId = 0;

const rpc = (
  base: string,
  database: string,
  method: string,
  params: unknown,
  token?: string,
): Promise<{ status: number; body: any }> =>
  json(base, `/db/${database}/mcp`, {
    method: "POST",
    headers: MCP_HEADERS,
    ...(token === undefined ? {} : { token }),
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });

const callTool = async (
  base: string,
  database: string,
  token: string,
  name: string,
  args: unknown,
): Promise<{ isError: boolean; value: any }> => {
  const response = await rpc(base, database, "tools/call", { name, arguments: args }, token);
  expect(response.status).toBe(200);
  expect(response.body.error).toBeUndefined();
  const result = response.body.result;

  expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
  return { isError: result.isError === true, value: result.structuredContent };
};

const ok = async (
  base: string,
  database: string,
  token: string,
  name: string,
  args: unknown,
): Promise<any> => {
  const result = await callTool(base, database, token, name, args);
  expect(result).toMatchObject({ isError: false });
  return result.value;
};

const install = async (base: string, database: string, tx: unknown[]): Promise<void> => {
  const installed = await testAdmin(base, database, "/transact", { tx });
  expect(installed.status).toBe(200);
};

const waitForCheckpoint = async (
  base: string,
  database: string,
  name: string,
): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt++) {
    const status = await testAdmin(base, database, "/checkpoint", {
      scope: "worker",
      action: "status",
    });
    if (status.body.checkpoints?.[name]?.pending === true) return;
    await Bun.sleep(25);
  }
  throw new Error(`the request did not reach the worker ${name} checkpoint`);
};

const ref = (described: any, owner: string, name: string) => {
  const found = described.operations.find(
    (operation: any) => operation.owner.name === owner && operation.name === name,
  );
  expect(found).toBeDefined();
  return { owner: found.owner, name: found.name, version: found.version };
};

export const registerMcp = (ctx: { urls: () => LocalUrls }) => {
  describe("experimental MCP endpoint", () => {
    let member = "";
    let reader = "";

    beforeAll(async () => {
      member = await signToken("mcp", "member");
      reader = await signToken("mcp", "reader");
    });

    test("credentials are an HTTP challenge; the kernel is marked experimental", async () => {
      const base = ctx.urls().nativeOperationsUrl;
      const database = "operations-mcp-describe";
      for (const token of [undefined, "not-a-token"]) {
        const refused = await rpc(base, database, "tools/list", {}, token);
        expect(refused.status).toBe(401);

        expect(refused.body).toEqual({ error: "unauthorized" });
      }

      const initialized = await rpc(base, database, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "local-suite", version: "0" },
      }, member);
      expect(initialized.status).toBe(200);
      expect(initialized.body.result.serverInfo.name).toBe("ramose");
      expect(initialized.body.result.instructions).toContain("EXPERIMENTAL");

      const listed = await rpc(base, database, "tools/list", {}, member);
      expect(listed.body.result.tools.map((tool: any) => tool.name).sort())
        .toEqual(["describe", "mutate", "query"]);
    });

    test("describe projects only what this principal may see", async () => {
      const base = ctx.urls().nativeOperationsUrl;
      const database = "operations-mcp-describe";
      await install(base, database, schemaTx(OperationSchema));

      const discovered = await ok(base, database, member, "describe", {});
      expect(discovered.operations.length).toBeGreaterThan(0);
      const createItem = ref(discovered, "nativeItem", "create");
      const createOther = ref(discovered, "nativeOther", "create");
      expect(createItem.version).toMatch(/^ov_[A-Za-z0-9_-]{43}$/);
      expect(createItem.version).not.toBe(createOther.version);

      await ok(base, database, member, "mutate", {
        operation: createItem,
        input: { title: "described" },
        invocationId: crypto.randomUUID(),
      });
      await ok(base, database, member, "mutate", {
        operation: createOther,
        input: { name: `other-${crypto.randomUUID()}` },
        invocationId: crypto.randomUUID(),
      });

      const asMember = await ok(base, database, member, "describe", {});
      expect(asMember.entities).toEqual(["nativeItem"]);

      expect(asMember.truncated).toBe(false);
      expect(JSON.stringify(asMember)).not.toContain(database);

      const asReader = await ok(base, database, reader, "describe", {});
      expect(asReader.entities.sort()).toEqual(["nativeItem", "nativeOther"]);

      expect(asReader.operations).toEqual([]);
    });

    test("query returns rows, and hidden reads exactly like absent", async () => {
      const base = ctx.urls().nativeOperationsUrl;
      const database = "operations-mcp-query";
      await install(base, database, schemaTx(OperationSchema));
      const discovered = await ok(base, database, member, "describe", {});
      const read = (query: unknown) => ok(base, database, member, "query", { query });

      for (const title of ["alpha", "beta"]) {
        await ok(base, database, member, "mutate", {
          operation: ref(discovered, "nativeItem", "create"),
          input: { title },
          invocationId: crypto.randomUUID(),
        });
      }
      const secret = `secret-${crypto.randomUUID()}`;
      await ok(base, database, member, "mutate", {
        operation: ref(discovered, "nativeOther", "create"),
        input: { name: secret },
        invocationId: crypto.randomUUID(),
      });
      for (const label of ["encoded", "encoded-two"]) {
        await ok(base, database, member, "mutate", {
          operation: ref(discovered, "nativeEncoded", "create"),
          input: { label },
          invocationId: crypto.randomUUID(),
        });
      }

      const filtered = await read({
        version: 1,
        from: { entity: "nativeItem" },
        where: { title: "alpha" },
        select: ["title", "state"],
      });
      expect(filtered.rows).toEqual([{ title: "alpha", state: "new" }]);

      const encoded = await read({
        version: 1,
        from: { entity: "nativeEncoded" },
        where: { label: "encoded" },
      });

      expect(encoded.rows).toEqual([{
        label: "encoded",
        at: { $inst: 1_700_000_000_000 },
        blob: { $bytes: "AQID+g==" },
        key: "8f14e45f-ceea-467a-9c8b-4e2f9b7c1a30",
      }]);

      const limited = await read({ version: 1, from: { entity: "nativeItem" }, limit: 1 });
      expect(limited.rows).toHaveLength(1);
      expect(limited.truncated).toBe(true);

      expect(Object.keys(limited.rows[0]).some((key) => key.startsWith(":"))).toBe(false);

      const hidden = await read({
        version: 1,
        from: { entity: "nativeOther" },
        select: ["name"],
      });
      expect(hidden).toEqual({ rows: [], truncated: false });
      expect(await read({ version: 1, from: { entity: "noSuchEntity" }, select: ["name"] }))
        .toEqual(hidden);
      expect(await read({
        version: 1,
        from: { entity: "nativeItem" },
        select: ["noSuchField"],
      })).toEqual(hidden);

      expect(await read({
        version: 1,
        from: { entity: "nativeEncoded" },
        select: ["secret"],
      })).toEqual(hidden);
      expect(await read({
        version: 1,
        from: { entity: "nativeItem" },
        select: ["invalidRef"],
      })).toEqual(hidden);

      const overLimit = await read({
        version: 1,
        from: { entity: "nativeItem" },
        limit: 1,
      });
      expect(overLimit.truncated).toBe(true);
      for (const select of [["secret"], ["invalidRef"], ["noSuchField"]]) {
        expect(await read({
          version: 1,
          from: { entity: "nativeItem" },
          select,
          limit: 1,
        })).toEqual({ rows: [], truncated: false });
      }

      expect(await read({
        version: 1,
        from: { entity: "nativeEncoded" },
        select: ["tenantOnly"],
        limit: 1,
      })).toEqual({ rows: [], truncated: false });

      const acme = await signToken("mcp", "member", "user_acme", { tenant: "acme" });
      expect((await ok(base, database, acme, "query", {
        query: {
          version: 1,
          from: { entity: "nativeEncoded" },
          where: { label: "encoded" },
          select: ["tenantOnly"],
        },
      })).rows).toEqual([{ tenantOnly: "acme-only" }]);

      expect((await read({
        version: 1,
        from: { entity: "nativeEncoded" },
        where: { label: "encoded" },
        select: ["label"],
      })).rows).toEqual([{ label: "encoded" }]);

      expect((await read({ version: 1, from: { entity: "nativeEncoded" }, limit: 1 }))
        .truncated).toBe(true);
      expect(await read({
        version: 1,
        from: { entity: "nativeEncoded" },
        select: ["rowScoped"],
        limit: 1,
      })).toEqual({ rows: [], truncated: false });

      expect(await read({
        version: 1,
        from: { entity: "nativeEncoded" },
        select: ["label", "rowScoped"],
        limit: 1,
      })).toMatchObject({ rows: [{ label: expect.any(String) }], truncated: true });

      expect(await read({
        version: 1,
        from: { entity: "nativeEncoded" },
        select: ["sealedNote"],
        limit: 1,
      })).toEqual({ rows: [], truncated: false });

      const visible = await ok(base, database, reader, "query", {
        query: { version: 1, from: { entity: "nativeOther" }, select: ["name"] },
      });
      expect(visible.rows).toContainEqual({ name: secret });

      expect(await callTool(base, database, member, "query", {
        query: { version: 2, from: { entity: "nativeItem" } },
      })).toMatchObject({
        isError: true,
        value: { code: "invalid_query", retryable: false },
      });
    });

    test("mutate commits once, replays exactly, and refuses a reused id", async () => {
      const base = ctx.urls().nativeOperationsUrl;
      const database = "operations-mcp-mutate";
      await install(base, database, schemaTx(OperationSchema));
      const discovered = await ok(base, database, member, "describe", {});
      const create = ref(discovered, "nativeItem", "create");
      const invocationId = crypto.randomUUID();
      const call = (title: string, id = invocationId, operation = create) => ({
        operation,
        input: { title },
        invocationId: id,
      });

      const committed = await ok(base, database, member, "mutate", call("once"));
      expect(committed).toMatchObject({ invocationId, status: "completed" });

      expect(committed.outcome).toEqual({ withheld: "outcome" });
      expect(JSON.stringify(committed.outcome)).not.toMatch(/\d/);
      expect(await ok(base, database, member, "mutate", call("once"))).toEqual(committed);

      const rows = await ok(base, database, member, "query", {
        query: {
          version: 1,
          from: { entity: "nativeItem" },
          where: { title: "once" },
          select: ["title"],
        },
      });
      expect(rows.rows).toEqual([{ title: "once" }]);

      expect(await callTool(base, database, member, "mutate", call("twice")))
        .toMatchObject({
          isError: true,
          value: { code: "invocation_conflict", retryable: false },
        });

      const stale = { ...create, version: ref(discovered, "nativeOther", "create").version };
      expect(await callTool(
        base,
        database,
        member,
        "mutate",
        call("stale", crypto.randomUUID(), stale),
      )).toMatchObject({
        isError: true,
        value: { code: "operation_changed", retryable: true },
      });

      const renamed = await ok(base, database, member, "mutate", {
        operation: ref(discovered, "nativeEncoded", "createRenamed"),
        input: { label: "renamed" },
        invocationId: crypto.randomUUID(),
      });
      expect(renamed.outcome).toEqual(committed.outcome);
      expect(JSON.stringify(renamed)).not.toContain("wire_id");

      const opaque = await ok(base, database, member, "mutate", {
        operation: ref(discovered, "nativeEncoded", "opaqueOutcome"),
        input: { label: "opaque" },
        invocationId: crypto.randomUUID(),
      });
      expect(opaque.outcome).toEqual(committed.outcome);
      expect(JSON.stringify(opaque)).not.toContain("principalEid");
      expect(JSON.stringify(opaque.outcome)).not.toMatch(/\d/);

      const plain = await ok(base, database, member, "mutate", {
        operation: ref(discovered, "nativeItem", "returnTransportTag"),
        input: {},
        invocationId: crypto.randomUUID(),
      });
      expect(plain.outcome).toEqual({ $inst: "application-value" });

      const names = discovered.operations.map((operation: any) => operation.name);
      expect(names).toContain("create");
      expect(names).not.toContain("rename");

      expect((await ok(base, database, member, "query", {
        query: {
          version: 1,
          from: { entity: "nativeEncoded" },
          where: { label: "renamed" },
          select: ["label"],
        },
      })).rows).toEqual([{ label: "renamed" }]);

      expect(await callTool(base, database, member, "mutate", {
        operation: ref(discovered, "nativeItem", "reject"),
        input: {},
        invocationId: crypto.randomUUID(),
      })).toMatchObject({
        isError: true,
        value: { code: "operation_rejected", message: "domain refused" },
      });

      expect(await callTool(
        base,
        database,
        reader,
        "mutate",
        call("denied", crypto.randomUUID()),
      )).toMatchObject({
        isError: true,
        value: { code: "inaccessible", retryable: false },
      });
    });

    test("a credential expiring mid-flight commits but discloses nothing", async () => {
      const base = ctx.urls().nativeOperationsUrl;
      const database = "operations-mcp-expiry";
      await install(base, database, schemaTx(OperationSchema));

      const warmed = await testAdmin(base, database, "/query", {
        query: "[:find ?e :where [?e :nativeItem/title ?title]]",
      });
      expect(warmed.status).toBe(200);

      const exp = Math.floor(Date.now() / 1_000) + 4;
      const expiring = await signToken(database, "member", "user_ada", undefined, { exp });
      const discovered = await ok(base, database, expiring, "describe", {});
      const armed = await testAdmin(base, database, "/checkpoint", {
        scope: "worker",
        action: "arm-wait",
        name: "operation.response",

        releaseAfterMs: exp * 1_000 - Date.now() + 25,
      });
      expect(armed.status).toBe(200);

      const title = "Committed before response expiry";
      const invocationId = crypto.randomUUID();
      const create = ref(discovered, "nativeItem", "create");
      const pending = callTool(base, database, expiring, "mutate", {
        operation: create,
        input: { title },
        invocationId,
      });
      await waitForCheckpoint(base, database, "operation.response");

      const expired = await pending;
      expect(Date.now()).toBeGreaterThanOrEqual(exp * 1_000);

      expect(Object.hasOwn(expired.value, "outcome")).toBe(false);
      expect(Object.hasOwn(expired.value, "invocationId")).toBe(false);

      expect(expired).toMatchObject({
        isError: true,
        value: { code: "invocation_indeterminate", retryable: true },
      });
      expect(expired.value.message).toContain("same invocationId");

      const committedRows = async () => {
        const persisted = await testAdmin(base, database, "/query", {
          query: `[:find ?e :where [?e :nativeItem/title ${JSON.stringify(title)}]]`,
        });
        expect(persisted.status).toBe(200);
        return persisted.body.result as unknown[];
      };
      expect(await committedRows()).toEqual([[expect.any(Number)]]);

      const renewed = await signToken(database, "member", "user_ada");
      const replayed = await ok(base, database, renewed, "mutate", {
        operation: create,
        input: { title },
        invocationId,
      });
      expect(replayed).toMatchObject({ invocationId, status: "completed" });

      expect(await committedRows()).toEqual([[expect.any(Number)]]);
    });

    test("an unreadable field never reaches the budgeted query path", async () => {

      const base = ctx.urls().mcpBudgetUrl;
      const database = "operations-mcp-budget";
      await install(base, database, schemaTx(OperationSchema));
      const discovered = await ok(base, database, member, "describe", {});
      await ok(base, database, member, "mutate", {
        operation: ref(discovered, "nativeEncoded", "create"),
        input: { label: "budgeted" },
        invocationId: crypto.randomUUID(),
      });
      const select = (fields: readonly string[]) =>
        callTool(base, database, member, "query", {
          query: { version: 1, from: { entity: "nativeEncoded" }, select: fields },
        });

      const visible = await select(["label"]);
      expect(visible).toMatchObject({
        isError: true,
        value: { code: "query_budget_exceeded", retryable: true },
      });

      expect(visible.value.message).not.toMatch(/\d/);

      const unknown = await select(["noSuchField"]);
      expect(unknown).toEqual({
        isError: false,
        value: { rows: [], truncated: false },
      });
      expect(await select(["secret"])).toEqual(unknown);
      expect(await select(["sealedNote"])).toEqual(unknown);

      const fromEntity = (entity: string) =>
        callTool(base, database, member, "query", {
          query: { version: 1, from: { entity }, select: ["name"] },
        });
      expect(await fromEntity("noSuchEntity")).toEqual(unknown);
      expect(await fromEntity("nativeOther")).toEqual(unknown);

      expect(await callTool(base, database, member, "query", {
        query: {
          version: 1,
          from: { entity: "nativeEncoded" },
          where: JSON.parse('{"__proto__": "x"}'),
          select: ["label"],
        },
      })).toEqual(unknown);
    });

  });
};
