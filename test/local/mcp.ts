/**
 * The experimental MCP endpoint against the real local topology (#484 S1).
 *
 * Every claim here crosses the Worker / Durable Object / R2 boundary: the
 * credential is verified by the deployed JWT verifier, `at` is resolved by the
 * deployed graph-path traversal, reads come from the deployed policy's
 * filtered `Db`, and writes commit through the authoritative Transactor's
 * invocation receipt path.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { schemaTx } from "../../packages/ramose/src/db/internal.ts";
import { signToken } from "../../packages/ramose/test/sign-local-token.ts";
import { json, testAdmin, type LocalUrls } from "./fixtures.ts";
import { GRAPH_PATH_ROOT_DATABASE, GraphPathRootSchema } from "./graph-path-catalog.ts";
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

/** One tool call. Reports the structured result and whether it is an error. */
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
  // The text block must be a mechanical restatement of the structured one.
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

/** The operation reference `describe` published, pinned to its own version. */
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
        // Nothing about the deployment, its tools, or its catalog may appear.
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

      const discovered = await ok(base, database, member, "describe", { at: [] });
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

      // `member` may read nativeItem; nativeOther is readable only by `reader`.
      const asMember = await ok(base, database, member, "describe", { at: [] });
      expect(asMember.entities).toEqual(["nativeItem"]);
      expect(asMember.graphs).toEqual([]);
      expect(asMember.truncated).toBe(false);
      expect(JSON.stringify(asMember)).not.toContain(database);

      // The same rows, a different principal: the row really exists, so the
      // omission above is authorization and not emptiness.
      const asReader = await ok(base, database, reader, "describe", { at: [] });
      expect(asReader.entities.sort()).toEqual(["nativeItem", "nativeOther"]);
      // No operation grant names `reader`, so nothing is invocable for them.
      expect(asReader.operations).toEqual([]);
    });

    test("query returns rows, and hidden reads exactly like absent", async () => {
      const base = ctx.urls().nativeOperationsUrl;
      const database = "operations-mcp-query";
      await install(base, database, schemaTx(OperationSchema));
      const discovered = await ok(base, database, member, "describe", { at: [] });
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

      const filtered = await read({
        version: 1,
        from: { entity: "nativeItem" },
        where: { title: "alpha" },
        select: ["title", "state"],
      });
      expect(filtered.rows).toEqual([{ title: "alpha", state: "new" }]);

      const limited = await read({ version: 1, from: { entity: "nativeItem" }, limit: 1 });
      expect(limited.rows).toHaveLength(1);
      expect(limited.truncated).toBe(true);
      // No entity id, transaction id, or storage locator may ride along.
      expect(Object.keys(limited.rows[0]).some((key) => key.startsWith(":"))).toBe(false);

      // Hidden, absent, and unknown must be one answer.
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

      // The reader proves the hidden row was really there all along.
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
      const discovered = await ok(base, database, member, "describe", { at: [] });
      const create = ref(discovered, "nativeItem", "create");
      const invocationId = crypto.randomUUID();
      const call = (title: string, id = invocationId, operation = create) => ({
        operation,
        input: { title },
        invocationId: id,
      });

      const committed = await ok(base, database, member, "mutate", call("once"));
      expect(committed).toMatchObject({ invocationId, status: "completed" });
      expect(typeof committed.outcome.id).toBe("number");
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

      // A well-formed version that is not this operation's: no effect occurs.
      const stale = { ...create, version: ref(discovered, "nativeItem", "rename").version };
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

      // The operation's own refusal surfaces as its message, not a 500.
      expect(await callTool(base, database, member, "mutate", {
        operation: ref(discovered, "nativeItem", "reject"),
        input: {},
        invocationId: crypto.randomUUID(),
      })).toMatchObject({
        isError: true,
        value: { code: "operation_rejected", message: "domain refused" },
      });

      // `reader` holds no invoke grant: the operation reads as unavailable.
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

    test("at traverses the authorized graph of graphs", async () => {
      const base = ctx.urls().graphPathsUrl;
      const database = GRAPH_PATH_ROOT_DATABASE;
      await install(base, database, schemaTx(GraphPathRootSchema));
      const root = await ok(base, database, member, "describe", { at: [] });
      const name = `mcp-${crypto.randomUUID().slice(0, 8)}`;
      await ok(base, database, member, "mutate", {
        at: [],
        operation: ref(root, "localWorkspace", "create"),
        input: { name },
        invocationId: crypto.randomUUID(),
      });

      const withChild = await ok(base, database, member, "describe", { at: [] });
      expect(withChild.entities).toContain("localWorkspace");
      expect(withChild.graphs).toContain(name);
      // An admin-only graph type is never named to this principal.
      expect(withChild.entities).not.toContain("localPrivateWorkspace");

      const child = await ok(base, database, member, "describe", { at: [name] });
      expect(child.operations.map((operation: any) => operation.owner.name))
        .toContain("localProject");
      expect(child.entities).toEqual([]);

      await ok(base, database, member, "mutate", {
        at: [name],
        operation: ref(child, "localProject", "create"),
        input: { name: "nested" },
        invocationId: crypto.randomUUID(),
      });
      const populated = await ok(base, database, member, "describe", { at: [name] });
      expect(populated.entities).toContain("localProject");

      // An unknown or unauthorized path is one collapsed answer.
      expect(await callTool(base, database, member, "describe", { at: ["no-such-graph"] }))
        .toMatchObject({
          isError: true,
          value: { code: "inaccessible", retryable: false },
        });
    });
  });
};
