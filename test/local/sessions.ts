/**
 * Replica sessions over the real local Worker, Durable Objects, SQLite, R2,
 * and WebSockets. The `/__test__` upgrade only forwards the real Replica DO
 * session endpoint; every frame and close below comes from that endpoint.
 */

import { describe, expect, test } from "bun:test";
import { signToken } from "../../packages/ramose/test/sign-local-token.ts";
import { recordingTransport, type RecordingTransport } from "../support/recorder.ts";
import { attr, testAdmin, uniqueDb, type LocalUrls } from "./fixtures.ts";
import { TEST_CAPABILITY } from "./test-hooks-env.ts";

type SocketHarness = {
  readonly socket: WebSocket;
  readonly recorder: RecordingTransport;
};

type SessionState = {
  readonly lastT: number;
  readonly watermark: number;
  readonly principal?: { readonly class?: string };
};

const TIMEOUT_MS = 8_000;

const socketUrl = (
  base: string,
  db: string,
  rest: "session" | "watch",
  token?: string,
): URL => {
  const url = new URL(`/__test__/db/${encodeURIComponent(db)}/${rest}`, base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("__ramose_test_capability", TEST_CAPABILITY);
  if (token !== undefined) url.searchParams.set("token", token);
  return url;
};

const openSocket = async (
  base: string,
  db: string,
  rest: "session" | "watch",
  token?: string,
): Promise<SocketHarness> => {
  for (let attempt = 0; ; attempt++) {
    const recorder = recordingTransport();
    const socket = new recorder.webSocket(socketUrl(base, db, rest, token));
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`${rest} socket timed out opening`)),
          TIMEOUT_MS,
        );
        socket.addEventListener("open", () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
        socket.addEventListener("error", () => {
          clearTimeout(timer);
          reject(new Error(`${rest} socket failed to open`));
        }, { once: true });
      });
      return { socket, recorder };
    } catch (error) {
      socket.close();
      if (attempt === 2) throw error;
      await Bun.sleep(50 * (attempt + 1));
    }
  }
};

const received = (harness: SocketHarness): unknown[] =>
  harness.recorder.frames
    .filter((frame) => frame.direction === "recv")
    .map((frame) => frame.payload);

const waitForFrame = async <A>(
  harness: SocketHarness,
  predicate: (frame: any) => frame is A,
  after = 0,
): Promise<A> => {
  const existing = received(harness).slice(after).find(predicate);
  if (existing !== undefined) return existing;
  return new Promise<A>((resolve, reject) => {
    const timer = setTimeout(() => {
      harness.socket.removeEventListener("message", onMessage);
      reject(new Error(`WebSocket frame timed out: ${JSON.stringify(received(harness))}`));
    }, TIMEOUT_MS);
    const onMessage = (event: MessageEvent) => {
      let frame: unknown;
      try {
        frame = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (!predicate(frame)) return;
      clearTimeout(timer);
      harness.socket.removeEventListener("message", onMessage);
      resolve(frame);
    };
    harness.socket.addEventListener("message", onMessage);
  });
};

const waitForClose = (
  harness: SocketHarness,
): Promise<{ code: number; reason: string }> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket close timed out")), TIMEOUT_MS);
    harness.socket.addEventListener("close", (event) => {
      clearTimeout(timer);
      resolve({ code: event.code, reason: event.reason });
    }, { once: true });
  });

const send = (harness: SocketHarness, frame: unknown): void => {
  harness.socket.send(JSON.stringify(frame));
};

const replyWithId = (id: number) =>
  (frame: any): frame is { id: number; status?: number; ok?: boolean; body?: any; principal?: any } =>
    frame !== null && typeof frame === "object" && frame.id === id;

const basisAt = (t: number) =>
  (frame: any): frame is { kind: "basis"; t: number } =>
    frame !== null && typeof frame === "object" && frame.kind === "basis" && frame.t === t;

const readyFrame = (frame: any): frame is { kind: "ready"; t: number } =>
  frame !== null && typeof frame === "object" && frame.kind === "ready" &&
  typeof frame.t === "number";

const bootstrap = async (base: string, db: string): Promise<number> => {
  const response = await testAdmin(base, db, "/transact", {
    tx: [attr(":session/value", "string")],
  });
  expect(response.status).toBe(200);
  return response.body.t as number;
};

const sessions = async (base: string, db: string): Promise<SessionState[]> => {
  const response = await testAdmin(base, db, "/sessions", {});
  expect(response.status).toBe(200);
  return response.body.sessions as SessionState[];
};

const waitFor = async (check: () => Promise<boolean>, label: string): Promise<void> => {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(25);
  }
  throw new Error(`${label} timed out`);
};

const syncFrom = async (
  harness: SocketHarness,
  id: number,
  from: number,
): Promise<{ id: number; status?: number; body?: any }> => {
  const seen = received(harness).length;
  send(harness, { id, op: "sync", from });
  return waitForFrame(harness, replyWithId(id), seen);
};

export function registerSessions(target: { urls: () => LocalUrls }): void {
  describe("real Replica DO sessions", () => {
    test("two sessions advance in commit order while the fail-closed stream stays silent", async () => {
      const base = target.urls().openUrl;
      const db = uniqueDb("sessions");
      const initialT = await bootstrap(base, db);
      const first = await openSocket(base, db, "session");
      const second = await openSocket(base, db, "session");
      const firstWatch = await openSocket(base, db, "watch");
      const secondWatch = await openSocket(base, db, "watch");
      try {
        await waitForFrame(firstWatch, readyFrame);
        await waitForFrame(secondWatch, readyFrame);
        expect((await syncFrom(first, 1, 0)).body.t).toBe(initialT);
        expect((await syncFrom(second, 1, 0)).body.t).toBe(initialT);

        const armed = await testAdmin(base, db, "/checkpoint", {
          scope: "replica",
          action: "arm-wait",
          name: "session.notify",
        });
        expect(armed.status).toBe(200);

        const one = await testAdmin(base, db, "/transact", {
          tx: [{ ":session/value": "one" }],
        });
        expect(one.status).toBe(200);
        await waitFor(async () => {
          const status = await testAdmin(base, db, "/checkpoint", {
            scope: "replica",
            action: "status",
          });
          return status.body.checkpoints?.["session.notify"]?.pending === true;
        }, "replica notify checkpoint");

        const two = await testAdmin(base, db, "/transact", {
          tx: [{ ":session/value": "two" }],
        });
        expect(two.status).toBe(200);
        expect(one.body.t).toBe(initialT + 1);
        expect(two.body.t).toBe(initialT + 2);
        expect((await sessions(base, db)).every((state) => state.watermark === initialT))
          .toBe(true);

        const released = await testAdmin(base, db, "/checkpoint", {
          scope: "replica",
          action: "release",
          name: "session.notify",
        });
        expect(released.status).toBe(200);

        for (const watch of [firstWatch, secondWatch]) {
          await waitForFrame(watch, basisAt(one.body.t));
          await waitForFrame(watch, basisAt(two.body.t));
          const basisTs = received(watch)
            .filter((frame: any) => frame?.kind === "basis")
            .map((frame: any) => frame.t);
          expect(basisTs).toEqual([one.body.t, two.body.t]);
        }
        await waitFor(async () => {
          const state = await sessions(base, db);
          return state.length === 2 && state.every((session) => session.watermark === two.body.t);
        }, "both session cursors");
        for (const session of [first, second]) {
          expect(received(session).some((frame: any) => frame?.op === "tx" || frame?.op === "resync"))
            .toBe(false);
        }
      } finally {
        first.socket.close();
        second.socket.close();
        firstWatch.socket.close();
        secondWatch.socket.close();
      }
    });

    test("snapshot, tail, write denial, and closure use the real socket", async () => {
      const base = target.urls().openUrl;
      const db = uniqueDb("resync");
      await bootstrap(base, db);
      const seed = await testAdmin(base, db, "/transact", {
        tx: [{ ":session/value": "seed" }],
      });
      expect(seed.status).toBe(200);
      const indexed = await testAdmin(base, db, "/index", {});
      expect(indexed.status).toBe(200);
      expect(indexed.body.toT).toBe(seed.body.t);

      const session = await openSocket(base, db, "session");
      try {
        const start = received(session).length;
        send(session, { id: 1, op: "sync", from: 0 });
        const resync = await waitForFrame(
          session,
          (frame: any): frame is { op: "resync"; t: number; datoms: unknown[] } =>
            frame?.op === "resync",
          start,
        );
        const synced = await waitForFrame(session, replyWithId(1), start);
        expect(resync).toEqual({ op: "resync", t: seed.body.t, datoms: [] });
        expect(synced).toMatchObject({ status: 200, body: { t: seed.body.t, from: 0 } });

        const malformed = received(session).length;
        session.socket.send("}{ not json");
        expect(await waitForFrame(session, replyWithId(0), malformed)).toMatchObject({
          status: 400,
          body: { error: "frame must be JSON" },
        });
        const info = received(session).length;
        send(session, { id: 4, op: "info" });
        expect(await waitForFrame(session, replyWithId(4), info)).toMatchObject({
          status: 401,
          body: { error: "unauthorized" },
        });

        const denied = received(session).length;
        send(session, {
          id: 2,
          op: "transact",
          tx: [{ ":session/value": "must-not-land" }],
        });
        expect(await waitForFrame(session, replyWithId(2), denied)).toMatchObject({
          status: 401,
          body: { error: "unauthorized" },
        });

        const tail = await testAdmin(base, db, "/transact", {
          tx: [{ ":session/value": "tail" }],
        });
        expect(tail.status).toBe(200);
        expect(tail.body.t).toBe(seed.body.t + 1);
        await waitFor(async () =>
          (await sessions(base, db)).some((state) => state.watermark === tail.body.t),
        "tail cursor");
        const tailSync = await syncFrom(session, 3, seed.body.t);
        expect(tailSync).toMatchObject({
          status: 200,
          body: { t: tail.body.t, from: seed.body.t },
        });
        expect(received(session).filter((frame: any) => frame?.op === "resync"))
          .toEqual([resync]);

        const closed = waitForClose(session);
        session.socket.close(1000, "test complete");
        expect((await closed).code).toBe(1000);
        await waitFor(async () => (await sessions(base, db)).length === 0, "session removal");
      } finally {
        if (session.socket.readyState < WebSocket.CLOSING) session.socket.close();
      }
    });

    test("JWT transition, refusal, and expiry run through the deployed verifier", async () => {
      const base = target.urls().policyUrl;
      const db = uniqueDb("authsession");
      await bootstrap(base, db);
      const member = await signToken(db, "member", "ada");
      const admin = await signToken(db, "admin", "bob");
      const session = await openSocket(base, db, "session", member);
      try {
        send(session, { id: 1, op: "auth", token: admin });
        expect(await waitForFrame(session, replyWithId(1))).toMatchObject({
          id: 1,
          ok: true,
          principal: { class: "admin" },
        });
        send(session, { id: 2, op: "auth", token: "not.a.jwt" });
        expect(await waitForFrame(session, replyWithId(2))).toMatchObject({
          id: 2,
          status: 401,
          body: { error: "unauthorized" },
        });
        await waitFor(async () =>
          (await sessions(base, db)).some((state) => state.principal?.class === "admin"),
        "persisted auth transition");
      } finally {
        session.socket.close();
      }

      const now = Math.floor(Date.now() / 1_000);
      const expired = await signToken(db, "member", "eve", undefined, {
        iat: now - 2,
        exp: now - 1,
      });
      const expiring = await openSocket(base, db, "session", expired);
      const closed = waitForClose(expiring);
      send(expiring, { id: 3, op: "info" });
      expect(await waitForFrame(expiring, replyWithId(3))).toMatchObject({
        status: 401,
        body: { error: "token expired" },
      });
      expect((await closed).code).toBe(1008);
    });

    test("an induced notify failure closes watches and a real session catches up", async () => {
      const base = target.urls().openUrl;
      const db = uniqueDb("notifyfail");
      const initialT = await bootstrap(base, db);
      const session = await openSocket(base, db, "session");
      const watch = await openSocket(base, db, "watch");
      try {
        await waitForFrame(watch, readyFrame);
        expect((await syncFrom(session, 1, 0)).body.t).toBe(initialT);
        const armed = await testAdmin(base, db, "/checkpoint", {
          scope: "replica",
          action: "arm-throw",
          name: "session.notify",
          error: "induced notify failure",
        });
        expect(armed.status).toBe(200);
        const watchClosed = waitForClose(watch);
        const committed = await testAdmin(base, db, "/transact", {
          tx: [{ ":session/value": "recover" }],
        });
        expect(committed.status).toBe(200);
        expect((await watchClosed).code).toBe(1011);

        expect((await sessions(base, db))[0]?.watermark).toBe(initialT);
        const recovered = await syncFrom(session, 2, initialT);
        expect(recovered).toMatchObject({
          status: 200,
          body: { t: committed.body.t, from: initialT },
        });
        expect((await sessions(base, db))[0]?.watermark).toBe(committed.body.t);
      } finally {
        session.socket.close();
        watch.socket.close();
      }
    });
  });
}
