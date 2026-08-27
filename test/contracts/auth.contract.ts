/**
 * Public auth behavior against a real local (or remote) peer.
 *
 * External `/db/*` is fail-closed until verified JWT admission, an
 * installed catalog, and a filtered `Db`. `/health` stays open.
 */

import { describe, expect, test } from "bun:test";
import { signToken } from "../../packages/ramose/test/sign-local-token.ts";
import { SHARED_TOKEN } from "../local/auth-keys.ts";
import { json, post, uniqueDb, type LocalUrls } from "../local/fixtures.ts";

export interface AuthTarget {
  readonly urls: () => LocalUrls;
}

const everyDbSurface = (base: string, db: string, token?: string) => [
  json(base, `/db/${encodeURIComponent(db)}/query`, post({ query: { find: ["?t"], where: [["?e", ":doc/title", "?t"]] } }, token)),
  json(base, `/db/${encodeURIComponent(db)}/info`, token === undefined ? {} : { token }),
  json(base, `/db/${encodeURIComponent(db)}/transact`, post({ tx: [{ ":doc/title": "x" }] }, token)),
];

export function registerAuthContract(target: AuthTarget): void {
  describe("configured database access is fail-closed", () => {
    test("/health is open and the demo console is not served", async () => {
      const { openUrl, policyUrl } = target.urls();
      expect((await json(openUrl, "/health")).status).toBe(200);
      expect((await json(policyUrl, "/health")).status).toBe(200);
      expect((await json(openUrl, "/")).status).toBe(404);
      expect((await json(policyUrl, "/")).status).toBe(404);
    });

    test("no token, shared token, and a signed JWT are all 401 on /db/*", async () => {
      const { openUrl, tokenUrl, policyUrl } = target.urls();
      const db = uniqueDb("acme");
      const jwt = await signToken(db, "admin");
      for (const [base, tok] of [
        [openUrl, undefined],
        [tokenUrl, SHARED_TOKEN],
        [policyUrl, jwt],
      ] as const) {
        for (const pending of everyDbSurface(base, db, tok)) {
          expect((await pending).status).toBe(401);
        }
      }
    });

    test("RAMOSE_TOKEN is not a data-plane principal", async () => {
      const { policyUrl } = target.urls();
      const db = uniqueDb("acme");
      const q = post({ query: { find: ["?t"], where: [["?e", ":doc/title", "?t"]] } }, SHARED_TOKEN);
      expect((await json(policyUrl, `/db/${db}/query`, q)).status).toBe(401);
      expect((await json(policyUrl, `/db/${db}/info`, { token: SHARED_TOKEN })).status).toBe(401);
    });
  });
}
