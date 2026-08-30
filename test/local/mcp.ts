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

/** Block until the real Worker parks on an armed checkpoint. */
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
      // Hidden entities and operations exist in this catalog, and none of them
      // may set `truncated`: the cap is consulted only after the visibility
      // predicate, so the flag can never be the tell that something is there.
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
      await ok(base, database, member, "mutate", {
        operation: ref(discovered, "nativeEncoded", "create"),
        input: { label: "encoded" },
        invocationId: crypto.randomUUID(),
      });

      const filtered = await read({
        version: 1,
        from: { entity: "nativeItem" },
        where: { title: "alpha" },
        select: ["title", "state"],
      });
      expect(filtered.rows).toEqual([{ title: "alpha", state: "new" }]);

      // Values JSON cannot represent natively keep the engine's canonical
      // wire encoding instead of being mangled by JSON.stringify — a
      // Uint8Array would otherwise arrive as an object of numeric indices and
      // a Date as an ISO string the client cannot tell from text. A uuid's
      // public value is already a canonical string, so it stays one.
      const encoded = await read({
        version: 1,
        from: { entity: "nativeEncoded" },
        where: { label: "encoded" },
      });
      // `secret` is declared on this visible entity and denied to `member`,
      // so the default projection omits it exactly as if it did not exist.
      expect(encoded.rows).toEqual([{
        label: "encoded",
        at: { $inst: 1_700_000_000_000 },
        blob: { $bytes: "AQID+g==" },
        key: "8f14e45f-ceea-467a-9c8b-4e2f9b7c1a30",
      }]);

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
      // A policy-hidden field on a *visible* entity with visible rows must
      // read the same as an unknown one. Reporting an empty row per readable
      // row would otherwise disclose both that the field exists and how many
      // rows the caller can see. A ref-shaped field is excluded for the same
      // reason and must land on the identical answer.
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

      // …and they take that answer *without running a query at all*, which is
      // what keeps them off the budgeted path a visible field takes: a
      // budgeted pull can fail, and the sealed empty answer cannot, so the
      // two must never share a code path. `truncated` is the observable
      // proof. It is now a fact about the query, so a hidden selection that
      // had reached the engine would come back `truncated: true` here —
      // `nativeItem` holds more rows than this limit and every one of them
      // would be fetched and then dropped by the projection.
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
      // …while the same rows are plainly there through a visible field.
      expect((await read({
        version: 1,
        from: { entity: "nativeEncoded" },
        select: ["label"],
      })).rows).toEqual([{ label: "encoded" }]);

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
      // The declared output can reach an EntityId, and S1 has no public entity
      // reference to publish one as. The contract alone decides, so the whole
      // outcome is withheld and no codec can place a storage id somewhere a
      // slot-by-slot projection would have failed to look.
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

      // The same reference-carrying contract behind a codec that renames the
      // key (`encodeKeys({ id: "wire_id" })`) must be byte-identical: the rule
      // reads the contract, never the encoded value, so no rename, injected
      // key, or relocation into a scalar slot can change the answer.
      const renamed = await ok(base, database, member, "mutate", {
        operation: ref(discovered, "nativeEncoded", "createRenamed"),
        input: { label: "renamed" },
        invocationId: crypto.randomUUID(),
      });
      expect(renamed.outcome).toEqual(committed.outcome);
      expect(JSON.stringify(renamed)).not.toContain("wire_id");

      // A contract that cannot reach a reference still publishes its result.
      const plain = await ok(base, database, member, "mutate", {
        operation: ref(discovered, "nativeItem", "returnTransportTag"),
        input: {},
        invocationId: crypto.randomUUID(),
      });
      expect(plain.outcome).toEqual({ $inst: "application-value" });
      // The write itself still committed.
      expect((await ok(base, database, member, "query", {
        query: {
          version: 1,
          from: { entity: "nativeEncoded" },
          where: { label: "renamed" },
          select: ["label"],
        },
      })).rows).toEqual([{ label: "renamed" }]);

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

    test("a credential expiring mid-flight commits but discloses nothing", async () => {
      const base = ctx.urls().nativeOperationsUrl;
      const database = "operations-mcp-expiry";
      await install(base, database, schemaTx(OperationSchema));
      // Initialize the real Replica before arming module-isolate checkpoint
      // state. DO constructors intentionally reset stale test hooks.
      const warmed = await testAdmin(base, database, "/query", {
        query: "[:find ?e :where [?e :nativeItem/title ?title]]",
      });
      expect(warmed.status).toBe(200);

      const exp = Math.floor(Date.now() / 1_000) + 4;
      const expiring = await signToken(database, "member", "user_ada", undefined, { exp });
      const discovered = await ok(base, database, expiring, "describe", { at: [] });
      const armed = await testAdmin(base, database, "/checkpoint", {
        scope: "worker",
        action: "arm-wait",
        name: "operation.response",
        // The delay starts once the real Worker boundary is reached, so this
        // releases the parked response after the JWT is exact-expired.
        releaseAfterMs: exp * 1_000 - Date.now() + 25,
      });
      expect(armed.status).toBe(200);

      const title = "Committed before response expiry";
      const pending = callTool(base, database, expiring, "mutate", {
        operation: ref(discovered, "nativeItem", "create"),
        input: { title },
        invocationId: crypto.randomUUID(),
      });
      await waitForCheckpoint(base, database, "operation.response");

      const expired = await pending;
      expect(Date.now()).toBeGreaterThanOrEqual(exp * 1_000);
      // Same fence `/op` applies after the awaited Transactor hop: the output
      // may be derived from data this caller can no longer read, so none of
      // it is disclosed and the refusal names nothing.
      expect(expired).toMatchObject({
        isError: true,
        value: { code: "inaccessible", retryable: false },
      });
      expect(Object.hasOwn(expired.value, "outcome")).toBe(false);
      expect(Object.hasOwn(expired.value, "invocationId")).toBe(false);

      // As on `/op`, the write itself stayed committed.
      const persisted = await testAdmin(base, database, "/query", {
        query: `[:find ?e :where [?e :nativeItem/title ${JSON.stringify(title)}]]`,
      });
      expect(persisted.status).toBe(200);
      expect(persisted.body.result).toEqual([[expect.any(Number)]]);
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
