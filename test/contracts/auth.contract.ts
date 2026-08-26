/**
 * Public auth behavior against a real local (or remote) peer.
 *
 * Tokens are real JWTs signed with the checked-in test key. Each test
 * uses a unique database name — the peer is shared.
 */

import { describe, expect, test } from "bun:test";
import { signToken } from "../../packages/ramose/test/sign-local-token.ts";
import { SHARED_TOKEN } from "../local/auth-keys.ts";
import {
  AUTH_SCHEMA,
  attr,
  json,
  post,
  seedTx,
  uniqueDb,
  type LocalUrls,
} from "../local/fixtures.ts";

export interface AuthTarget {
  readonly urls: () => LocalUrls;
}

const titles = async (base: string, db: string, tok?: string) => {
  const { body } = await json(
    base,
    `/db/${encodeURIComponent(db)}/query`,
    post({ query: { find: ["?t"], where: [["?e", ":doc/title", "?t"]] } }, tok),
  );
  return ((body.result as string[][]) ?? []).map((r) => r[0]).sort();
};

const seedAuth = async (base: string, db: string, token?: string) => {
  await seedTx(base, db, AUTH_SCHEMA, token);
  return seedTx(
    base,
    db,
    [
      { ":db/id": "ada", ":user/sub": "user_ada" },
      { ":db/id": "bob", ":user/sub": "user_bob" },
      { ":db/id": "carol", ":user/sub": "user_carol" },
      { ":db/id": "org", ":org/members": ["ada", "bob"] },
      { ":db/id": "proj", ":project/org": "org" },
      {
        ":db/id": "doc",
        ":doc/title": "Roadmap",
        ":doc/owner": "ada",
        ":doc/project": "proj",
        ":doc/audit": "read-by-ops",
      },
      { ":db/id": "solo", ":doc/title": "Carol private", ":doc/owner": "carol" },
    ],
    token,
  );
};

export function registerAuthContract(target: AuthTarget): void {
  describe("no policy — today's behaviour, unchanged", () => {
    test("no RAMOSE_TOKEN: open, and the demo console is served", async () => {
      const { openUrl } = target.urls();
      const db = uniqueDb("open");
      await seedTx(openUrl, db, AUTH_SCHEMA);
      expect(
        (
          await json(
            openUrl,
            `/db/${db}/query`,
            post({ query: { find: ["?t"], where: [["?e", ":doc/title", "?t"]] } }),
          )
        ).status,
      ).toBe(200);
      expect((await json(openUrl, "/")).status).toBe(200);
    });

    test("RAMOSE_TOKEN set: shared-token mode, full access with it and 401 without", async () => {
      const { tokenUrl } = target.urls();
      const db = uniqueDb("tok");
      await seedTx(tokenUrl, db, AUTH_SCHEMA, SHARED_TOKEN);
      const q = post({ query: { find: ["?t"], where: [["?e", ":doc/title", "?t"]] } });
      expect((await json(tokenUrl, `/db/${db}/query`, { ...q, token: SHARED_TOKEN })).status).toBe(200);
      expect((await json(tokenUrl, `/db/${db}/query`, q)).status).toBe(401);
      expect((await json(tokenUrl, `/db/${db}/query`, { ...q, token: "wrong" })).status).toBe(401);
      expect(
        (
          await json(
            tokenUrl,
            `/db/${db}/transact`,
            post({ tx: [attr(":x/y", "string")] }, SHARED_TOKEN),
          )
        ).status,
      ).toBe(200);
    });
  });

  describe("policy configured", () => {
    test("/health is open, the demo console is not served", async () => {
      const { policyUrl } = target.urls();
      expect((await json(policyUrl, "/health")).status).toBe(200);
      expect((await json(policyUrl, "/")).status).toBe(404);
    });

    test("RAMOSE_TOKEN is not a data-plane principal on a named database", async () => {
      const { policyUrl } = target.urls();
      const db = uniqueDb("acme");
      const admin = await signToken(db, "admin");
      await seedAuth(policyUrl, db, admin);
      expect((await json(policyUrl, "/health", { token: SHARED_TOKEN })).status).toBe(200);
      const q = post({ query: { find: ["?t"], where: [["?e", ":doc/title", "?t"]] } }, SHARED_TOKEN);
      expect((await json(policyUrl, `/db/${db}/query`, q)).status).toBe(401);
      expect((await json(policyUrl, `/db/${db}/info`, { token: SHARED_TOKEN })).status).toBe(401);
      expect(
        (await json(policyUrl, `/db/${db}/admin/index`, { method: "POST", token: SHARED_TOKEN })).status,
      ).toBe(401);
      expect(
        (
          await json(
            policyUrl,
            `/db/${db}/transact`,
            post({ tx: [{ ":doc/title": "by the shared token" }] }, SHARED_TOKEN),
          )
        ).status,
      ).toBe(401);
      expect(await titles(policyUrl, db, admin)).toEqual(["Carol private", "Roadmap"]);
    });

    test("ramose.db is an exact match — nothing else opens another name", async () => {
      const { policyUrl } = target.urls();
      const db = uniqueDb("acme");
      const admin = await signToken(db, "admin");
      await seedAuth(policyUrl, db, admin);
      const acme = await signToken(db, "member");
      const other = await signToken("other", "member");
      const q = { query: { find: ["?t"], where: [["?e", ":doc/title", "?t"]] } };
      expect((await json(policyUrl, `/db/${db}/query`, post(q, acme))).status).toBe(200);
      expect((await json(policyUrl, `/db/other/query`, post(q, acme))).status).toBe(401);
      expect((await json(policyUrl, `/db/${db}/query`, post(q, other))).status).toBe(401);
    });

    test("wrong aud / iss, an expired token, an over-long TTL and an undeclared class are all 401", async () => {
      const { policyUrl } = target.urls();
      const db = uniqueDb("acme");
      const admin = await signToken(db, "admin");
      await seedAuth(policyUrl, db, admin);
      const q = post({ query: { find: ["?t"], where: [["?e", ":doc/title", "?t"]] } });
      const now = Math.floor(Date.now() / 1000);
      const bad = [
        await signToken(db, "member", "user_ada", undefined, { aud: "ramose:peer:other" }),
        await signToken(db, "member", "user_ada", undefined, { iss: "https://evil.test" }),
        await signToken(db, "member", "user_ada", undefined, { iat: now - 600, exp: now - 10 }),
        await signToken(db, "member", "user_ada", undefined, { iat: now, exp: now + 7200 }),
        await signToken(db, "root"),
        "not-a-jwt",
      ];
      for (const t of bad) {
        expect((await json(policyUrl, `/db/${db}/query`, { ...q, token: t })).status).toBe(401);
      }
      expect(
        (await json(policyUrl, `/db/${db}/query`, { ...q, token: await signToken(db, "member") })).status,
      ).toBe(200);
    });

    test("no token is the anonymous class (which this policy grants nothing)", async () => {
      const { policyUrl } = target.urls();
      const db = uniqueDb("acme");
      await seedAuth(policyUrl, db, await signToken(db, "admin"));
      const { status, body } = await json(
        policyUrl,
        `/db/${db}/query`,
        post({ query: { find: ["?t"], where: [["?e", ":doc/title", "?t"]] } }),
      );
      expect(status).toBe(200);
      expect(body.result).toEqual([]);
    });

    test("no token is 401 when the policy declares no anonymous class", async () => {
      const { policyClosedUrl } = target.urls();
      const db = uniqueDb("acme");
      await seedAuth(policyClosedUrl, db, await signToken(db, "admin"));
      expect(
        (
          await json(
            policyClosedUrl,
            `/db/${db}/query`,
            post({ query: { find: ["?t"], where: [["?e", ":doc/title", "?t"]] } }),
          )
        ).status,
      ).toBe(401);
    });
  });

  describe("reads are a filtered Db", () => {
    test("a query only sees what the rules allow, per principal", async () => {
      const { policyUrl } = target.urls();
      const db = uniqueDb("acme");
      await seedAuth(policyUrl, db, await signToken(db, "admin"));
      expect(await titles(policyUrl, db, await signToken(db, "member", "user_ada"))).toEqual(["Roadmap"]);
      expect(await titles(policyUrl, db, await signToken(db, "member", "user_carol"))).toEqual([
        "Carol private",
      ]);
      expect(await titles(policyUrl, db, await signToken(db, "admin", "user_ada"))).toEqual([
        "Carol private",
        "Roadmap",
      ]);
    });

    test("a variable attribute ([?e ?a ?v]) is filtered too — :doc/audit is admin-only", async () => {
      const { policyUrl } = target.urls();
      const db = uniqueDb("acme");
      const seeded = await seedAuth(policyUrl, db, await signToken(db, "admin"));
      const values = async (tok: string) => {
        const { body } = await json(
          policyUrl,
          `/db/${db}/query`,
          post({ query: { find: ["?v"], where: [[seeded.tempids.doc, "?a", "?v"]] } }, tok),
        );
        return (body.result as unknown[][]).map((r) => r[0]);
      };
      const member = await values(await signToken(db, "member", "user_ada"));
      expect(member).toContain("Roadmap");
      expect(member).not.toContain("read-by-ops");
      expect(await values(await signToken(db, "admin"))).toContain("read-by-ops");
    });

    test("pull redacts a masked attribute; entity and pull of an invisible entity come back empty", async () => {
      const { policyUrl } = target.urls();
      const db = uniqueDb("acme");
      const seeded = await seedAuth(policyUrl, db, await signToken(db, "admin"));
      const member = await signToken(db, "member", "user_ada");
      const pulled = await json(
        policyUrl,
        `/db/${db}/pull`,
        post({ eid: seeded.tempids.doc, pattern: [":doc/title", ":doc/audit"] }, member),
      );
      expect(pulled.body.result[":doc/title"]).toBe("Roadmap");
      expect(pulled.body.result[":doc/audit"]).toBeUndefined();
      const hidden = await json(
        policyUrl,
        `/db/${db}/pull`,
        post({ eid: seeded.tempids.solo, pattern: [":doc/title"] }, member),
      );
      expect(hidden.body.result?.[":doc/title"]).toBeUndefined();
      const entity = await json(policyUrl, `/db/${db}/entity/${seeded.tempids.solo}`, { token: member });
      expect(entity.body.entity?.[":doc/title"]).toBeUndefined();
    });
  });

  describe("writes and privileged surfaces", () => {
    test("member data tx is refused; admin bypasses", async () => {
      const { policyUrl } = target.urls();
      const db = uniqueDb("acme");
      const seeded = await seedAuth(policyUrl, db, await signToken(db, "admin"));
      const carol = await signToken(db, "member", "user_carol");
      const { status, body } = await json(
        policyUrl,
        `/db/${db}/transact`,
        post({ tx: [[":db/add", seeded.tempids.doc, ":doc/title", "hacked"]] }, carol),
      );
      expect(status).toBe(403);
      expect(body.code).toBe("operations");
      expect(JSON.stringify(body)).not.toContain("hacked");
      const admin = await signToken(db, "admin", "user_ops");
      expect(
        (
          await json(
            policyUrl,
            `/db/${db}/transact`,
            post({ tx: [[":db/add", seeded.tempids.solo, ":doc/title", "renamed"]] }, admin),
          )
        ).status,
      ).toBe(200);
    });

    test("a non-admin's ensure of an already-deployed subset is skipped; a new ident is 403", async () => {
      const { policyUrl } = target.urls();
      const db = uniqueDb("acme");
      await seedAuth(policyUrl, db, await signToken(db, "admin"));
      const member = await signToken(db, "member");
      const subset = {
        tx: [attr(":doc/title", "string"), attr(":user/sub", "string", { ":db/unique": ":db.unique/identity" })],
      };
      const res = await json(policyUrl, `/db/${db}/transact`, post(subset, member));
      expect(res.status).toBe(200);
      expect(res.body.datoms).toEqual([]);
      const fresh = await json(
        policyUrl,
        `/db/${db}/transact`,
        post({ tx: [attr(":doc/secret", "string")] }, member),
      );
      expect(fresh.status).toBe(403);
      expect(fresh.body.code).toBe("policy");
      expect(fresh.body.attr).toBe(":doc/secret");
      expect(
        (
          await json(
            policyUrl,
            `/db/${db}/transact`,
            post({ tx: [attr(":doc/secret", "string")] }, await signToken(db, "admin")),
          )
        ).status,
      ).toBe(200);
    });

    test("a schema class cannot smuggle an app write inside an ensure map", async () => {
      const { policySchemaUrl } = target.urls();
      const db = uniqueDb("acme");
      const seeded = await seedAuth(policySchemaUrl, db, await signToken(db, "admin"));
      const member = await signToken(db, "member", "user_ada");
      const mixed = {
        tx: [
          {
            ...attr(":junk/one", "string"),
            ":doc/owner": { ":db/id": seeded.tempids.solo, ":doc/title": "PWNED" },
          },
        ],
      };
      const res = await json(policySchemaUrl, `/db/${db}/transact`, post(mixed, member));
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("operations");
      expect(await titles(policySchemaUrl, db, member)).toEqual(["Roadmap"]);
    });

    test("explain and /admin/* are admin-only; /info reduces to { db, t, principal }", async () => {
      const { policyUrl } = target.urls();
      const db = uniqueDb("acme");
      await seedAuth(policyUrl, db, await signToken(db, "admin"));
      const member = await signToken(db, "member");
      const admin = await signToken(db, "admin");
      const q = { query: { find: ["?t"], where: [["?e", ":doc/title", "?t"]] }, explain: true };
      expect((await json(policyUrl, `/db/${db}/query`, post(q, member))).status).toBe(403);
      expect((await json(policyUrl, `/db/${db}/query`, post(q, admin))).status).toBe(200);
      expect((await json(policyUrl, `/db/${db}/admin/index`, { method: "POST", token: member })).status).toBe(
        403,
      );
      expect((await json(policyUrl, `/db/${db}/admin/index`, { method: "POST", token: admin })).status).toBe(
        200,
      );
      const info = await json(policyUrl, `/db/${db}/info`, { token: member });
      expect(Object.keys(info.body).sort()).toEqual(["db", "principal", "t"]);
      const adminInfo = await json(policyUrl, `/db/${db}/info`, { token: admin });
      expect(adminInfo.body.transactor).toBeDefined();
    });

    test("/info tells the caller who it is and provisions the principal row", async () => {
      const { policyUrl } = target.urls();
      const db = uniqueDb("acme");
      const seeded = await seedAuth(policyUrl, db, await signToken(db, "admin"));
      const ada = await json(policyUrl, `/db/${db}/info`, {
        token: await signToken(db, "member", "user_ada"),
      });
      expect(ada.body.principal).toEqual({ eid: seeded.tempids.ada, class: "member" });
      const anon = await json(policyUrl, `/db/${db}/info`);
      expect(anon.body.principal).toEqual({ eid: null, class: "anonymous" });
      const zoeTok = await signToken(db, "member", "user_zoe");
      const first = await json(policyUrl, `/db/${db}/info`, { token: zoeTok });
      expect(first.body.principal.class).toBe("member");
      expect(first.body.principal.eid).toBeGreaterThan(0);
      const again = await json(policyUrl, `/db/${db}/info`, { token: zoeTok });
      expect(again.body.principal).toEqual(first.body.principal);
    });

    test("User.role and ramose.attrs materialize on first /info", async () => {
      const { policyUrl } = target.urls();
      const db = uniqueDb("acme");
      const admin = await signToken(db, "admin");
      await seedTx(
        policyUrl,
        db,
        [
          ...AUTH_SCHEMA,
          attr(":user/role", "string"),
          attr(":user/name", "string"),
          attr(":user/email", "string"),
        ],
        admin,
      );
      const member = await signToken(db, "member", "user_ida", {
        name: "Ida",
        email: "ida@acme.test",
      });
      const first = await json(policyUrl, `/db/${db}/info`, { token: member });
      const eid = first.body.principal.eid as number;
      expect(eid).toBeGreaterThan(0);
      const pulled = await json(
        policyUrl,
        `/db/${db}/pull`,
        post({ eid, pattern: [":user/sub", ":user/role", ":user/name", ":user/email"] }, member),
      );
      expect(pulled.body.result).toMatchObject({
        ":user/sub": "user_ida",
        ":user/role": "member",
        ":user/name": "Ida",
        ":user/email": "ida@acme.test",
      });
    });

    test("no policy: /info still names the caller — class admin", async () => {
      const { openUrl } = target.urls();
      const db = uniqueDb("demo");
      await seedTx(openUrl, db, AUTH_SCHEMA);
      const info = await json(openUrl, `/db/${db}/info`);
      expect(info.body.principal).toEqual({ eid: null, class: "admin" });
    });

    test("CORS narrows to RAMOSE_ALLOWED_ORIGINS once a policy is configured", async () => {
      const { policyUrl } = target.urls();
      const ok = await fetch(`${policyUrl}/health`, {
        headers: { origin: "https://app.acme.test" },
      });
      expect(ok.headers.get("access-control-allow-origin")).toBe("https://app.acme.test");
      const nope = await fetch(`${policyUrl}/health`, {
        headers: { origin: "https://evil.test" },
      });
      expect(nope.headers.get("access-control-allow-origin")).toBeNull();
    });
  });

  describe("RAMOSE_JWKS_SERVICE — the issuer is a sibling Worker", () => {
    test("the JWKS fetch is dispatched through the named binding", async () => {
      const { jwksBoundUrl } = target.urls();
      const db = uniqueDb("acme");
      const admin = await signToken(db, "admin");
      await seedAuth(jwksBoundUrl, db, admin);
      expect((await json(jwksBoundUrl, `/db/${db}/info`, { token: admin })).status).toBe(200);
    });

    test("without the binding the same peer 401s", async () => {
      const { jwksUrlOnlyUrl } = target.urls();
      const db = uniqueDb("acme");
      const admin = await signToken(db, "admin");
      expect((await json(jwksUrlOnlyUrl, `/db/${db}/info`, { token: admin })).status).toBe(401);
    });
  });
}
