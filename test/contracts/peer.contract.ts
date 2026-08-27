/**
 * Peer behavioral contract — health stays open; `/db/*` is fail-closed
 * until verified JWT admission and authorized snapshots land.
 *
 * The same suite runs against Alchemy local mode and a deployed `RAMOSE_URL`.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { Peer } from "../support/ramoseHttp.ts";

/** Where the contract should run. `url` is read from test bodies. */
export interface PeerTarget {
  readonly url: () => string;
  readonly token?: () => string | undefined;
  readonly enabled?: boolean;
  /** Prefix for unique database names. @default `"e2e"` */
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
      const base = target.url().replace(/\/+$/, "");
      const headers: Record<string, string> = { "content-type": "application/json" };
      const token = tokenOf();
      if (token) headers.authorization = `Bearer ${token}`;
      const paths = [
        [`/db/${dbName}/transact`, "POST", JSON.stringify({ tx: [{ ":user/name": "Ada" }] })],
        [`/db/${dbName}/query`, "POST", JSON.stringify({ query: { find: ["?e"], where: [["?e", ":user/name", "?n"]] } })],
        [`/db/${dbName}/pull`, "POST", JSON.stringify({ eid: 1, pattern: ["*"] })],
        [`/db/${dbName}/info`, "GET", undefined],
      ] as const;
      for (const [path, method, body] of paths) {
        const res = await fetch(`${base}${path}`, {
          method,
          headers,
          ...(body === undefined ? {} : { body }),
        });
        expect(res.status).toBe(401);
      }
    });

    test("the demo console is not served", async () => {
      const res = await fetch(`${target.url().replace(/\/+$/, "")}/`);
      expect(res.status).toBe(404);
    });
  });
}
