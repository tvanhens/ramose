import { describe, expect, test } from "bun:test";
import { recordingTransport } from "../support/recorder.ts";
import {
  attr,
  fetchPastProxyBlip,
  json,
  localUrls,
  testAdmin,
  uniqueDb,
  type LocalUrls,
} from "./fixtures.ts";
import { TEST_CAPABILITY } from "./test-hooks-env.ts";

export function registerInstrumentation(target: { urls: () => LocalUrls }): void {
  describe("forwarding instrumentation on the local peer", () => {
    test("recording fetch forwards /health and records the real 200", async () => {
      const rec = recordingTransport();
      const url = `${target.urls().openUrl.replace(/\/+$/, "")}/health`;
      const res = await fetchPastProxyBlip(url, {}, "health", rec.fetch);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ ok: true, service: "ramose" });
      expect(res.headers.get("x-ramose-deployment")).toBeNull();
      expect(rec.calls.length).toBeGreaterThanOrEqual(1);
      expect(rec.calls.at(-1)?.status).toBe(200);
      expect(rec.calls.at(-1)?.url).toContain("/health");
    });

    test("recording fetch forwards a fail-closed /db/* 401 without inventing success", async () => {
      const rec = recordingTransport();
      const db = uniqueDb("rec");
      const res = await fetchPastProxyBlip(
        `${target.urls().openUrl.replace(/\/+$/, "")}/db/${db}/info`,
        {},
        "fail-closed info",
        rec.fetch,
      );
      expect(res.status).toBe(401);
      expect(rec.calls.at(-1)?.status).toBe(401);
    });

    test("test admin is the only /__test__ path; /db/* stays 401", async () => {
      const urls = localUrls();
      const db = uniqueDb("adm");
      const closed = await json(urls.openUrl, `/db/${db}/transact`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tx: [] }),
      });
      expect(closed.status).toBe(401);
      const status = await testAdmin(urls.openUrl, db, "/checkpoint", { action: "status" });
      expect(status.status).toBe(200);
      expect(status.body.ok).toBe(true);
    });

    test("the production entry has no test route even with test env bindings", async () => {
      const urls = localUrls();
      const db = uniqueDb("prodclosed");
      const response = await json(
        urls.emptyUrl,
        `/__test__/db/${db}/checkpoint`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "status" }),
        },
      );
      expect(response.status).toBe(404);
      expect(JSON.stringify(response.body)).toBe('{"error":"not found"}');
    });

    test("the testing entry requires its private capability", async () => {
      const urls = localUrls();
      const db = uniqueDb("testcap");
      const url = `${urls.openUrl.replace(/\/+$/, "")}/__test__/db/${db}/checkpoint`;
      for (const headers of [
        { "content-type": "application/json" },
        {
          "content-type": "application/json",
          "x-ramose-test-capability": "caller-controlled",
        },
      ]) {
        const response = await fetchPastProxyBlip(
          url,
          {
            method: "POST",
            headers,
            body: JSON.stringify({ action: "status" }),
          },
          "private capability",
        );
        expect(response.status).toBe(404);
        expect(JSON.stringify(await response.json())).toBe('{"error":"not found"}');
      }
    });

    test("writes and reads real local R2 bytes, including corrupt payloads", async () => {
      const urls = localUrls();
      const db = uniqueDb("r2");
      const payload = btoa("not-a-segment");
      const put = await testAdmin(urls.openUrl, db, "/r2", {
        action: "put",
        key: "seg/corrupt",
        bodyBase64: payload,
      });
      expect(put.status).toBe(200);
      expect(put.body.ok).toBe(true);
      const got = await testAdmin(urls.openUrl, db, "/r2", {
        action: "get",
        key: "seg/corrupt",
      });
      expect(got.status).toBe(200);
      expect(got.body.found).toBe(true);
      expect(got.body.bodyBase64).toBe(payload);
      const listed = await testAdmin(urls.openUrl, db, "/r2", {
        action: "list",
        prefix: "seg/",
      });
      expect(listed.body.objects.some((o: { key: string }) => o.key === "seg/corrupt")).toBe(true);
    });

    test("worker-scope checkpoints arm, report, and release per database", async () => {
      const urls = localUrls();
      const db = uniqueDb("cpw");
      const other = uniqueDb("cpw-other");
      const armed = await testAdmin(urls.openUrl, db, "/checkpoint", {
        action: "arm-throw",
        name: "session.open",
        error: "induced",
      });
      expect(armed.status).toBe(200);
      const status = await testAdmin(urls.openUrl, db, "/checkpoint", { action: "status" });
      expect(status.body.checkpoints["session.open"]?.action).toBe("throw");
      const foreign = await testAdmin(urls.openUrl, other, "/checkpoint", { action: "status" });
      expect(foreign.body.checkpoints["session.open"]).toBeUndefined();
      const released = await testAdmin(urls.openUrl, db, "/checkpoint", {
        action: "release",
        name: "session.open",
      });
      expect(released.status).toBe(200);
      const after = await testAdmin(urls.openUrl, db, "/checkpoint", { action: "status" });
      expect(after.body.checkpoints["session.open"]).toBeUndefined();
    });

    test("replica watch pushes a real committed basis without polling", async () => {
      const urls = localUrls();
      const db = uniqueDb("watch");
      const schema = await testAdmin(urls.openUrl, db, "/transact", {
        tx: [attr(":watch/value", "string")],
      });
      expect(schema.status).toBe(200);
      const socketUrl = new URL(
        `/__test__/db/${encodeURIComponent(db)}/watch`,
        urls.openUrl,
      );
      socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
      socketUrl.searchParams.set("__ramose_test_capability", TEST_CAPABILITY);
      const rec = recordingTransport();
      const socket = new rec.webSocket(socketUrl);
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", () => reject(new Error("watch failed to open")), {
          once: true,
        });
      });
      const frame = new Promise<{
        kind?: unknown;
        t?: unknown;
        basis?: { v?: unknown; db?: unknown; t?: unknown; root?: unknown; novelty?: unknown };
      }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("basis notification timed out")), 5_000);
        socket.addEventListener("message", (event) => {
          const parsed = JSON.parse(String(event.data)) as {
            kind?: unknown;
            t?: unknown;
            basis?: { v?: unknown; db?: unknown; t?: unknown; root?: unknown; novelty?: unknown };
          };
          if (parsed.kind !== "basis") return;
          clearTimeout(timer);
          resolve(parsed);
        });
      });
      const committed = await testAdmin(urls.openUrl, db, "/transact", {
        tx: [{ ":watch/value": "pushed" }],
      });
      expect(committed.status).toBe(200);
      const pushed = await frame;
      expect(pushed.kind).toBe("basis");
      expect(pushed.t).toBe(committed.body.t);
      expect(pushed.basis).toMatchObject({
        v: 1,
        db,
        t: committed.body.t,
      });
      expect(pushed.basis?.root).toBeDefined();
      expect(Array.isArray(pushed.basis?.novelty)).toBe(true);
      expect(rec.frames.some((recorded) => recorded.direction === "recv" &&
        (recorded.payload as { kind?: unknown }).kind === "basis")).toBe(true);
      const closed = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("basis watch did not fail closed")), 5_000);
        socket.addEventListener("close", () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
      const reconnect = await testAdmin(urls.openUrl, db, "/reconnect", {});
      expect(reconnect.status).toBe(200);
      await closed;
    });

    test("transactor-scope checkpoint arms on the real DO isolate", async () => {
      const urls = localUrls();
      const db = uniqueDb("cpt");
      const armed = await testAdmin(urls.openUrl, db, "/checkpoint", {
        scope: "transactor",
        action: "arm-throw",
        name: "transactor.commit",
        error: "induced-rollback",
      });
      expect(armed.status).toBe(200);
      expect(armed.body.action).toBe("throw");
      const status = await testAdmin(urls.openUrl, db, "/checkpoint", {
        scope: "transactor",
        action: "status",
      });
      expect(status.status).toBe(200);
      expect(status.body.checkpoints["transactor.commit"]?.action).toBe("throw");
    });

    test("a transactor checkpoint armed for one database does not fire for another", async () => {
      const urls = localUrls();
      const armedDb = uniqueDb("cps-armed");
      const bystander = uniqueDb("cps-other");
      for (const db of [armedDb, bystander]) {
        const schema = await testAdmin(urls.openUrl, db, "/transact", {
          tx: [attr(":scoped/value", "string")],
        });
        expect(schema.status).toBe(200);
      }
      const armed = await testAdmin(urls.openUrl, armedDb, "/checkpoint", {
        scope: "transactor",
        action: "arm-throw",
        name: "transactor.commit",
        error: "induced-scoped-commit",
      });
      expect(armed.status).toBe(200);
      const unaffected = await testAdmin(urls.openUrl, bystander, "/transact", {
        tx: [{ ":scoped/value": "bystander" }],
      });
      expect(unaffected.status).toBe(200);
      const blocked = await testAdmin(urls.openUrl, armedDb, "/transact", {
        tx: [{ ":scoped/value": "armed" }],
      }).then(
        (response) => response.status,
        () => "rejected" as const,
      );
      expect(blocked).not.toBe(200);
    });

    test("aborting the transactor DO starts a fresh isolate (checkpoint state is gone)", async () => {
      const urls = localUrls();
      const db = uniqueDb("abt");
      const armed = await testAdmin(urls.openUrl, db, "/checkpoint", {
        scope: "transactor",
        action: "arm-wait",
        name: "transactor.commit",
      });
      expect(armed.status).toBe(200);
      const aborted = await testAdmin(urls.openUrl, db, "/abort", { target: "transactor" });
      expect(aborted.status).toBe(200);
      expect(aborted.body.aborted).toBe(true);
      const status = await testAdmin(urls.openUrl, db, "/checkpoint", {
        scope: "transactor",
        action: "status",
      });
      expect(status.status).toBe(200);
      expect(status.body.checkpoints["transactor.commit"]).toBeUndefined();
    });
  });
}
