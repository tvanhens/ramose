import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { HttpError, Peer } from "../support/ramoseHttp.ts";

export interface PeerTarget {
  readonly url: () => string;
  readonly token?: () => string | undefined;
  readonly enabled?: boolean;

  readonly prefix?: string;
}

export function registerPeerContract(target: PeerTarget): void {
  const enabled = target.enabled ?? true;
  const d = enabled ? describe : describe.skip;
  const tokenOf = () => target.token?.();
  const prefix = target.prefix ?? "e2e";

  setDefaultTimeout(90_000);

  const dbName = `${prefix}-${Date.now().toString(36)}`;

  d("ramose e2e", () => {
    test("M0: worker answers", async () => {
      const client = new Peer(target.url(), { token: tokenOf(), retryTransientMs: 45_000 });
      const h = await client.health();
      expect(h.ok).toBe(true);
    });

    test("external /db/* is 401 even with a bearer token", async () => {
      const token = tokenOf();
      const client = new Peer(target.url(), { token, retryTransientMs: 45_000 });
      const paths = [
        [`/db/${dbName}/transact`, "POST", { tx: [{ ":user/name": "Ada" }] }],
        [`/db/${dbName}/query`, "POST", { query: { find: ["?e"], where: [["?e", ":user/name", "?n"]] } }],
        [`/db/${dbName}/pull`, "POST", { eid: 1, pattern: ["*"] }],
        [`/db/${dbName}/info`, "GET", undefined],
      ] as const;
      for (const [path, method, body] of paths) {
        let status = 200;
        try {
          await client.request(method, path, body);
        } catch (error) {
          if (!(error instanceof HttpError)) throw error;
          status = error.status;
        }
        expect(status).toBe(401);
      }
    });

    test("the demo console is not served", async () => {
      const res = await fetch(`${target.url().replace(/\/+$/, "")}/`);
      expect(res.status).toBe(404);
    });
  });
}
