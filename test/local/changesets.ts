import { DB_TX_INSTANT } from "../../packages/ramose/src/internal/core/schema.ts";
import { beforeAll, describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { lowerOwnedOperations } from "../../packages/ramose/src/internal/authorization/authoring/operations.ts";
import { CatalogId, DigestHex } from "../../packages/ramose/src/internal/authorization/identities.ts";
import { signToken } from "../../packages/ramose/test/sign-local-token.ts";
import { OperationSchema } from "./operation-catalog.ts";
import { json, testAdmin, type LocalUrls } from "./fixtures.ts";

export const registerChangesets = (ctx: { urls: () => LocalUrls }) => {
  describe("durable changesets", () => {
    let member: string;
    let approver: string;
    let outsider: string;
    let agent: string;
    let versions: Map<string, string>;
    beforeAll(async () => {
      member = await signToken("changesets", "member");
      approver = await signToken("changesets", "member", "user_ada", { approveChangesets: true });
      outsider = await signToken("changesets", "member", "other");
      agent = await signToken("changesets", "member", "user_ada", { requiresApproval: true, approveChangesets: true });
      const lowered = await Effect.runPromise(lowerOwnedOperations(CatalogId.make(OperationSchema.key), OperationSchema, DigestHex.make("3".repeat(64))));
      versions = new Map(lowered.descriptors.filter((op) => op.id.owner.name === "nativeItem")
        .map((op) => [op.id.localName, op.version]));
    });
    const request = (database: string, body: unknown, token = member) => json(ctx.urls().nativeOperationsUrl, `/db/${database}/changesets`, {
      method: "POST", token, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const operation = (localName: string, input: unknown, target?: string) => ({
      operation: { owner: { kind: "entity", name: "nativeItem" }, localName },
      operationVersion: versions.get(localName), input, ...(target === undefined ? {} : { target }),
    });
    const query = { version: 1, from: { entity: "nativeItem" }, select: ["title"], limit: 100 };

    test("survives restart, isolates draft reads, requires approval and commits exactly once", async () => {
      const db = "operations-changesets";
      const prepared = await request(db, { action: "prepare", id: "sprint", title: "Next sprint", operations: [
        operation("create", { title: "One" }), operation("create", { title: "Two" }),
      ] });
      expect(prepared.status).toBe(200);
      expect(prepared.body.status).toBe("draft");
      let revision = prepared.body.revision;
      const retry = await request(db, { action: "prepare", id: "sprint", title: "Next sprint", operations: [
        operation("create", { title: "One" }), operation("create", { title: "Two" }),
      ] });
      expect(retry.body.revision).toBe(revision);
      expect((await request(db, { action: "query", query })).body.rows).toEqual([]);
      const preview = await request(db, { action: "query", id: "sprint", query });
      expect(preview.status).toBe(200);
      expect(preview.body.rows.map((row: any) => row.data.title).sort()).toEqual(["One", "Two"]);
      expect(preview.body.rows.every((row: any) => typeof row.entity === "string")).toBe(true);
      const firstRow = preview.body.rows.find((row: any) => row.data.title === "One");
      const appended = await request(db, { action: "append", id: "sprint", revision,
        operations: [operation("rename", { title: "One revised" }, firstRow.entity)] });
      expect(appended.status).toBe(200);
      expect(appended.body.revision).not.toBe(revision);
      revision = appended.body.revision;
      const extended = await request(db, { action: "query", id: "sprint", query });
      expect(extended.body.rows.find((row: any) => row.data.title === "One revised").entity).toBe(firstRow.entity);
      await testAdmin(ctx.urls().nativeOperationsUrl, db, "/checkpoint", {
        scope: "transactor", action: "arm-throw", name: "changeset.commit.write",
      });
      expect((await request(db, { action: "commit", id: "sprint", revision }, approver)).status).toBe(500);
      expect((await request(db, { action: "query", query })).body.rows).toEqual([]);
      expect((await request(db, { action: "inspect", id: "sprint" })).body.status).toBe("draft");
      expect((await request(db, { action: "inspect", id: "sprint" }, outsider)).status).toBe(403);
      expect((await request(db, { action: "commit", id: "sprint", revision })).status).toBe(403);
      await testAdmin(ctx.urls().nativeOperationsUrl, db, "/abort", {});
      expect((await request(db, { action: "inspect", id: "sprint" })).body.revision).toBe(revision);
      const approvalStarted = Date.now();
      const commits = await Promise.all([0, 1].map(() => request(db, { action: "commit", id: "sprint", revision }, approver)));
      expect(commits.map((result) => result.status)).toEqual([200, 200]);
      expect(commits.every((result) => result.body.status === "committed")).toBe(true);
      const log = await testAdmin(ctx.urls().nativeOperationsUrl, db, "/log", { from: prepared.body.basis });
      expect(log.body.entries).toHaveLength(1);
      expect(log.body.entries[0].txInstant).toBeGreaterThanOrEqual(approvalStarted);
      expect(log.body.entries[0].datoms.find((fact: any[]) => fact[1] === DB_TX_INSTANT)[3]).toBe(log.body.entries[0].txInstant);
      const live = await request(db, { action: "query", query });
      expect(live.body.rows.map((row: any) => row.data.title).sort()).toEqual(["One revised", "Two"]);
      await testAdmin(ctx.urls().nativeOperationsUrl, db, "/abort", {});
      expect((await request(db, { action: "commit", id: "sprint", revision }, approver)).body.status).toBe("committed");
    });

    test("stale proposals and replaced revisions cannot commit", async () => {
      const db = "operations-changesets-stale";
      const create = (id: string, title: string, revision?: string) => request(db, {
        action: "prepare", id, revision, title, operations: [operation("create", { title })],
      });
      const first = await create("first", "Before");
      expect(first.status).toBe(200);
      const revised = await create("first", "Revised", first.body.revision);
      expect(revised.status).toBe(200);
      expect((await request(db, { action: "commit", id: "first", revision: first.body.revision }, approver)).body.code)
        .toBe("changeset_revision_conflict");
      const other = await create("other", "Other");
      expect(other.body.changes.find((fact: any) => fact.field === ":nativeItem/title").entity)
        .not.toBe(first.body.changes.find((fact: any) => fact.field === ":nativeItem/title").entity);
      expect((await request(db, { action: "commit", id: "other", revision: other.body.revision }, approver)).status).toBe(200);
      expect((await request(db, { action: "inspect", id: "first" })).body.stale).toBe(true);
      expect((await request(db, { action: "commit", id: "first", revision: revised.body.revision }, approver)).body.code)
        .toBe("changeset_stale");
      expect((await request(db, { action: "discard", id: "first", revision: revised.body.revision })).body.status).toBe("discarded");
    });

    test("snapshot reads do not hold the write queue and revisions cannot be substituted", async () => {
      const db = "operations-changesets-stale";
      const draft = await request(db, { action: "prepare", id: "read-snapshot", title: "Snapshot", operations: [operation("create", { title: "Snapshot" })] });
      expect(draft.status).toBe(200);
      const rawQuery = { find: [["pull", "?e", [":db/id", ":nativeItem/title"]]], where: [["?e", ":nativeItem/title", "Snapshot"]] };
      const read = { action: "read", id: "read-snapshot", revision: draft.body.revision, query: rawQuery };
      expect((await request(db, { ...read, revision: "wrong" })).body.code).toBe("changeset_revision_conflict");
      await testAdmin(ctx.urls().nativeOperationsUrl, db, "/checkpoint", { scope: "transactor", action: "arm-wait", name: "changeset.read" });
      const reading = request(db, read);
      try {
        const deadline = Date.now() + 5000;
        let waiting = false;
        while (!waiting && Date.now() < deadline) {
          const state = await testAdmin(ctx.urls().nativeOperationsUrl, db, "/checkpoint", { scope: "transactor", action: "status" });
          waiting = state.body.checkpoints?.["changeset.read"]?.pending === true;
          if (!waiting) await Bun.sleep(10);
        }
        expect(waiting).toBe(true);
        const next = await request(db, { action: "prepare", id: "concurrent-write", title: "Concurrent", operations: [operation("create", { title: "Concurrent" })] });
        expect((await request(db, { action: "commit", id: next.body.id, revision: next.body.revision }, approver)).status).toBe(200);
      } finally {
        await testAdmin(ctx.urls().nativeOperationsUrl, db, "/checkpoint", { scope: "transactor", action: "release", name: "changeset.read" });
      }
      const captured = await reading;
      expect(captured.status).toBe(200);
      expect(captured.body.result[0][0][":nativeItem/title"]).toBe("Snapshot");
      expect(captured.body.entities.every((id: unknown) => typeof id === "string")).toBe(true);
      expect((await request(db, read)).status).toBe(200);
      await testAdmin(ctx.urls().nativeOperationsUrl, db, "/index", {});
      expect((await testAdmin(ctx.urls().nativeOperationsUrl, db, "/gc", {})).status).toBe(200);
      await testAdmin(ctx.urls().nativeOperationsUrl, db, "/abort", {});
      const restored = await request(db, read);
      expect(restored.status).toBe(200);
      expect(restored.body.result).toEqual(captured.body.result);
    });

    test("preparation releases the write queue and invited reviewers receive lifecycle updates", async () => {
      const db = "operations-changesets-concurrency";
      const before = await request(db, { action: "list" });
      const watching = request(db, { action: "watch", version: before.body.version });
      await testAdmin(ctx.urls().nativeOperationsUrl, db, "/checkpoint", { scope: "transactor", action: "arm-wait", name: "changeset.prepare" });
      const preparing = request(db, { action: "prepare", id: "slow", title: "Slow", reviewers: ["other"], operations: [operation("create", { title: "Slow" })] });
      try {
        const deadline = Date.now() + 5000;
        let waiting = false;
        while (!waiting && Date.now() < deadline) {
          const state = await testAdmin(ctx.urls().nativeOperationsUrl, db, "/checkpoint", { scope: "transactor", action: "status" });
          waiting = state.body.checkpoints?.["changeset.prepare"]?.pending === true;
          if (!waiting) await Bun.sleep(10);
        }
        expect(waiting).toBe(true);
        const write = await json(ctx.urls().nativeOperationsUrl, `/db/${db}/op`, { method: "POST", token: member,
          headers: { "content-type": "application/json" }, body: JSON.stringify({ ...operation("create", { title: "Live" }), invocationId: "during-prepare" }) });
        expect(write.status).toBe(200);
      } finally {
        await testAdmin(ctx.urls().nativeOperationsUrl, db, "/checkpoint", { scope: "transactor", action: "release", name: "changeset.prepare" });
      }
      const prepared = await preparing;
      expect(prepared.status).toBe(200);
      expect(prepared.body.stale).toBe(true);
      expect((await watching).status).toBe(200);
      const inbox = await request(db, { action: "list" }, outsider);
      expect(inbox.body.items.map((item: any) => item.id)).toContain("slow");
      expect((await request(db, { action: "inspect", id: "slow" }, outsider)).status).toBe(200);
      const watch = request(db, { action: "watch", version: inbox.body.version }, outsider);
      expect((await request(db, { action: "discard", id: "slow", revision: prepared.body.revision })).status).toBe(200);
      expect((await watch).body.items.find((item: any) => item.id === "slow").status).toBe("discarded");
    });

    test("retained revisions survive collection of their old published roots", async () => {
      const db = "operations-changesets-concurrency";
      expect((await testAdmin(ctx.urls().nativeOperationsUrl, db, "/index", {})).status).toBe(200);
      const draft = await request(db, { action: "prepare", id: "retained", title: "Retained", operations: [operation("create", { title: "Retained" })] });
      expect(draft.status).toBe(200);
      const before = await request(db, { action: "query", id: "retained", query });
      for (let index = 0; index < 22; index++) {
        const response = await json(ctx.urls().nativeOperationsUrl, `/db/${db}/op`, { method: "POST", token: member,
          headers: { "content-type": "application/json" }, body: JSON.stringify({ ...operation("create", { title: `Later ${index}` }), invocationId: `later-${index}` }) });
        expect(response.status).toBe(200);
        expect((await testAdmin(ctx.urls().nativeOperationsUrl, db, "/index", {})).status).toBe(200);
      }
      const gc = await testAdmin(ctx.urls().nativeOperationsUrl, db, "/gc", {});
      expect(gc.status).toBe(200);
      expect(gc.body.retainedRoots).not.toContain(draft.body.basis);
      await testAdmin(ctx.urls().nativeOperationsUrl, db, "/abort", {});
      const after = await request(db, { action: "query", id: "retained", query });
      expect(after.status).toBe(200);
      expect(after.body.rows).toEqual(before.body.rows);
    });

    test("generic revision owners survive restart and scheduled proposal expiry", async () => {
      const db = "operations-changesets-retention";
      const draft = await request(db, { action: "prepare", id: "expiring", title: "Expires", operations: [operation("create", { title: "Expires" })] });
      expect(draft.status).toBe(200);
      const admin = (body: unknown) => testAdmin(ctx.urls().nativeOperationsUrl, db, "/revisions", body);
      const snapshot = await admin({ action: "save", namespace: "snapshot", name: "saved" });
      expect(snapshot.status).toBe(200);
      expect((await admin({ action: "reference", namespace: "branch", name: "work", revision: snapshot.body.revision })).status).toBe(200);
      await testAdmin(ctx.urls().nativeOperationsUrl, db, "/abort", {});
      expect((await admin({ action: "open", namespace: "snapshot", name: "saved" })).body.revision).toBe(snapshot.body.revision);
      await admin({ action: "release", namespace: "snapshot", name: "saved" });
      expect((await admin({ action: "open", namespace: "branch", name: "work" })).body.revision).toBe(snapshot.body.revision);
      const inbox = await request(db, { action: "list" });
      const watching = request(db, { action: "watch", version: inbox.body.version, id: "expiring" });
      expect((await admin({ action: "deadline", id: "expiring", delayMs: 300 })).status).toBe(200);
      const deadline = Date.now() + 8000;
      let state;
      do {
        state = await admin({ action: "inspect" });
        if (state.body.payloads === 0) break;
        await Bun.sleep(25);
      } while (Date.now() < deadline);
      expect(state!.body.payloads).toBe(0);
      expect(state!.body.expired).toEqual([{ id: "expiring" }]);
      expect(state!.body.owners).toEqual([{ namespace: "branch", name: "work", revision: snapshot.body.revision }]);
      expect((await watching).status).toBe(200);
      expect((await request(db, { action: "inspect", id: "expiring" })).body.code).toBe("changeset_expired");
      expect((await admin({ action: "open", namespace: "branch", name: "work" })).status).toBe(200);
      const leased = await admin({ action: "lease", namespace: "branch", name: "work" });
      expect(leased.status).toBe(200);
      expect(leased.body.during).toBe(0);
      expect(leased.body.remaining).toBe(0);
      expect((await admin({ action: "inspect" })).body.revisions).toBe(0);
    });

    test("the inbox pages indexed metadata and observes a proposal outside the current page", async () => {
      const db = "operations-changesets-retention";
      for (const id of ["page-a", "page-b", "page-c"]) {
        expect((await request(db, { action: "prepare", id, title: id, reviewers: ["other"], operations: [operation("create", { title: id })] })).status).toBe(200);
      }
      const first = await request(db, { action: "list", limit: 2 }, outsider);
      expect(first.body.items.map((item: any) => item.id)).toEqual(["page-a", "page-b"]);
      expect(first.body.nextCursor).toBe("page-b");
      const second = await request(db, { action: "list", after: first.body.nextCursor, limit: 2 }, outsider);
      expect(second.body.items.map((item: any) => item.id)).toEqual(["page-c"]);
      expect(second.body.nextCursor).toBeNull();
      const current = await request(db, { action: "watch", id: "page-c" }, outsider);
      const watching = request(db, { action: "watch", id: "page-c", version: current.body.version }, outsider);
      expect((await request(db, { action: "discard", id: "page-c", revision: current.body.items[0].revision })).status).toBe(200);
      expect((await watching).body.items[0].status).toBe("discarded");
      const storage = await testAdmin(ctx.urls().nativeOperationsUrl, db, "/revisions", { action: "inspect" });
      expect(storage.body.plan.every((row: any) => !row.detail.includes("SCAN"))).toBe(true);
    });

    test("failed batches never write live data or leave a partial proposal", async () => {
      const db = "operations-changesets-failure";
      const failed = await request(db, { action: "prepare", id: "failed", title: "Invalid", operations: [
        operation("create", { title: "Must stay isolated" }), operation("create", { title: 42 }),
      ] });
      expect(failed.status).not.toBe(200);
      expect((await request(db, { action: "query", query })).body.rows).toEqual([]);
      expect((await request(db, { action: "inspect", id: "failed" })).status).toBe(403);
    });

    test("agents discover and prepare work over MCP but cannot bypass human approval", async () => {
      const db = "operations-changesets-failure";
      const rpc = (method: string, params: unknown) => json(ctx.urls().nativeOperationsUrl, `/db/${db}/mcp`, {
        method: "POST", token: agent, headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const tools = await rpc("tools/list", {});
      expect(tools.body.result.tools.map((tool: any) => tool.name)).not.toContain("mutate");
      const described = await rpc("tools/call", { name: "changeset", arguments: { action: "describe" } });
      const operations = described.body.result.structuredContent.operations;
      const create = operations.find((op: any) => op.owner.name === "nativeItem" && op.name === "create");
      expect(create.input).toBeDefined();
      const prepared = await rpc("tools/call", { name: "changeset", arguments: {
        action: "prepare", id: "agent", title: "Agent proposal", operations: [{
          operation: { owner: create.owner, name: create.name, version: create.version }, input: { title: "Agent draft" },
        }],
      } });
      expect(prepared.body.result.isError).not.toBe(true);
      const proposal = prepared.body.result.structuredContent;
      const direct = await json(ctx.urls().nativeOperationsUrl, `/db/${db}/op`, {
        method: "POST", token: agent, headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...operation("create", { title: "Bypass" }), invocationId: "bypass" }),
      });
      expect(direct.status).toBe(403);
      expect((await request(db, { action: "commit", id: "agent", revision: proposal.revision }, agent)).status).toBe(403);
      expect((await request(db, { action: "query", query })).body.rows).toEqual([]);
      const inspected = await request(db, { action: "inspect", id: "agent" }, approver);
      expect(inspected.body.revision).toBe(proposal.revision);
      expect((await request(db, { action: "commit", id: "agent", revision: proposal.revision }, approver)).body.status).toBe("committed");
    });
  });
};
