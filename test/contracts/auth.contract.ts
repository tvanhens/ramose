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

    test("a verified JWT crosses admission before the closed data plane", async () => {
      const { policyUrl, jwksBoundUrl, jwksUrlOnlyUrl } = target.urls();
      const jwt = await signToken("acme", "member");
      expect((await json(policyUrl, "/db/-invalid/info")).status).toBe(401);
      expect((await json(policyUrl, `/db/-invalid/info?token=${encodeURIComponent(jwt)}`)).status).toBe(401);
      expect((await json(policyUrl, "/db/-invalid/info", { token: jwt })).status).toBe(400);
      const bound = await json(jwksBoundUrl, "/db/-invalid/info", {
        token: jwt,
      });
      expect(bound.status).toBe(400);
      expect(bound.body).toMatchObject({ error: "invalid database name" });
      expect((await json(jwksUrlOnlyUrl, "/db/-invalid/info", { token: jwt })).status).toBe(401);
    });

    test("a JWT without ramose.db crosses admission on any valid database the same way", async () => {
      const { policyUrl } = target.urls();
      const jwt = await signToken("acme", "member");
      const acme = await json(policyUrl, "/db/acme/info", { token: jwt });
      const other = await json(policyUrl, "/db/other/info", { token: jwt });
      expect(acme.status).toBe(401);
      expect(other.status).toBe(401);
      expect(acme.body).toEqual({ error: "unauthorized" });
      expect(other.body).toEqual({ error: "unauthorized" });
      expect((await json(policyUrl, "/db/-invalid/info", { token: jwt })).status).toBe(
        400,
      );
    });

    test("HTTP rejects query credentials even with Bearer or a spoofed upgrade", async () => {
      const { policyUrl } = target.urls();
      const jwt = await signToken("acme", "member");
      const path = `/db/-invalid/info?token=${encodeURIComponent(jwt)}`;

      expect((await json(policyUrl, path)).status).toBe(401);
      expect((await json(policyUrl, path, { token: jwt })).status).toBe(401);
      expect(
        (await json(policyUrl, path, { headers: { upgrade: "websocket" } }))
          .status,
      ).toBe(401);
    });

    test("authentication denial has one opaque response body", async () => {
      const { policyUrl } = target.urls();
      const diagnosticToken = "not.a.jwt-with-private-diagnostic";
      const response = await fetch(
        `${policyUrl.replace(/\/+$/, "")}/db/-invalid/info`,
        { headers: { authorization: `Bearer ${diagnosticToken}` } },
      );
      const text = await response.text();

      expect(response.status).toBe(401);
      expect(text).toBe('{"error":"unauthorized"}');
      expect(text).not.toContain(diagnosticToken);
      expect(text).not.toContain("JWT");
      expect(text).not.toContain("claim");
    });

    test("malformed database encoding is hidden until JWT admission", async () => {
      const { policyUrl } = target.urls();
      const path = "/db/%E0%A4%A/info";
      expect((await json(policyUrl, path)).status).toBe(401);

      const jwt = await signToken("acme", "member");
      const admitted = await json(policyUrl, path, { token: jwt });
      expect(admitted.status).toBe(400);
      expect(admitted.body).toMatchObject({ error: "invalid database name" });
    });

    test("WebSocket query and Bearer credentials cross real admission", async () => {
      const { policyUrl } = target.urls();
      const jwt = await signToken("acme", "member");
      const queryHeaders = { upgrade: "websocket" };

      expect(
        (
          await json(
            policyUrl,
            `/db/-invalid/session?token=${encodeURIComponent(jwt)}`,
            { headers: queryHeaders },
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await json(policyUrl, "/db/-invalid/session", {
            headers: queryHeaders,
            token: jwt,
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await json(
            policyUrl,
            `/db/acme/session?token=${encodeURIComponent(jwt)}`,
            { headers: queryHeaders },
          )
        ).status,
      ).toBe(401);
    });

    test("remote JWKS without its service binding fails closed but keeps health open", async () => {
      const { jwksUrlOnlyUrl } = target.urls();
      const jwt = await signToken("acme", "member");
      expect((await json(jwksUrlOnlyUrl, "/health")).status).toBe(200);
      expect(
        (await json(jwksUrlOnlyUrl, "/db/acme/info", { token: jwt })).status,
      ).toBe(401);
    });
  });
}
