/**
 * Forwarding recorders and `/__test__/*` admin against the real local Worker.
 *
 * `/db/*` stays fail-closed. These tests prove the instrumentation path:
 * record-and-forward, real R2 put/get, isolate checkpoints, DO abort.
 */

import { describe, expect, test } from "bun:test";
import { recordingTransport } from "../support/recorder.ts";
import { attr, json, localUrls, testAdmin, uniqueDb, type LocalUrls } from "./fixtures.ts";

const fetchPastProxyBlip = async (
  rec: ReturnType<typeof recordingTransport>,
  url: string,
): Promise<Response> => {
  for (let attempt = 0; ; attempt++) {
    const response = await rec.fetch(url);
    if (response.status !== 502 || attempt === 2) return response;
    await Bun.sleep(50 * (attempt + 1));
  }
};

export function registerInstrumentation(target: { urls: () => LocalUrls }): void {
  describe("forwarding instrumentation on the local peer", () => {
    test("recording fetch forwards /health and records the real 200", async () => {
      const rec = recordingTransport();
      const url = `${target.urls().openUrl.replace(/\/+$/, "")}/health`;
      const res = await fetchPastProxyBlip(rec, url);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok?: boolean; service?: string };
      expect(body.ok).toBe(true);
      expect(body.service).toBe("ramose");
      expect(res.headers.get("x-ramose-deployment")).not.toBeNull();
      expect(rec.calls.length).toBeGreaterThanOrEqual(1);
      expect(rec.calls.at(-1)?.status).toBe(200);
      expect(rec.calls.at(-1)?.url).toContain("/health");
    });

    test("recording fetch forwards a fail-closed /db/* 401 without inventing success", async () => {
      const rec = recordingTransport();
      const db = uniqueDb("rec");
      const res = await fetchPastProxyBlip(
        rec,
        `${target.urls().openUrl.replace(/\/+$/, "")}/db/${db}/info`,
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

    test("worker-scope checkpoints arm, report, and release", async () => {
      const urls = localUrls();
      const db = uniqueDb("cpw");
      const armed = await testAdmin(urls.openUrl, db, "/checkpoint", {
        action: "arm-throw",
        name: "session.open",
        error: "induced",
      });
      expect(armed.status).toBe(200);
      const status = await testAdmin(urls.openUrl, db, "/checkpoint", { action: "status" });
      expect(status.body.checkpoints["session.open"]?.action).toBe("throw");
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
