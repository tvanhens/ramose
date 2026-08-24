/**
 * The peer's handshake and enforcement, against the in-process peer
 * (harness.ts). Tokens are real JWTs, signed here with a throwaway ES256 key
 * whose public JWK is handed to the peer as `RAMOSE_JWKS_JSON` — the same
 * verifier path as a remote JWKS, without the network.
 *
 * The amendments this locks: `ramose.db` is an exact match, and `RAMOSE_TOKEN`
 * is not a data-plane principal on a named database.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { events } from "../internal/transactor/harness.ts";
import { type Peer, makePeer, post } from "./harness.ts";

// ---- signing ---------------------------------------------------------------

const ISS = "https://auth.acme.test";
const AUD = "ramose:peer:test";
let sign: (claims: Record<string, unknown>, over?: Record<string, unknown>) => Promise<string>;
let JWKS: string;

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  JWKS = JSON.stringify({ keys: [{ ...(await exportJWK(publicKey)), alg: "ES256", kid: "test" }] });
  sign = async (claims, over = {}) => {
    let jwt = new SignJWT(claims).setProtectedHeader({ alg: "ES256", kid: "test" });
    jwt = jwt.setIssuer((over.iss as string) ?? ISS).setAudience((over.aud as string) ?? AUD);
    jwt = jwt.setSubject((over.sub as string) ?? "user_ada");
    jwt = jwt.setIssuedAt((over.iat as number) ?? undefined).setExpirationTime((over.exp as string | number) ?? "5m");
    return jwt.sign(privateKey);
  };
});

/** A token for `db` with `class` (and optional app attrs). */
const token = (db: string, cls: string, sub = "user_ada", attrs?: Record<string, unknown>, over?: Record<string, unknown>) =>
  sign({ ramose: { db, class: cls, ...(attrs === undefined ? {} : { attrs }) } }, { sub, ...over });

// ---- the policy ------------------------------------------------------------

const allow = (expr: unknown) => [{ _tag: "allow", expr }];
const principal = { _tag: "principal" };
const eq = (attr: string, operand: unknown = principal) => ({ _tag: "eq", attr, operand });
const ref = (attr: string, target: unknown) => ({ _tag: "ref", attr, target });
/** doc → project → org → members ∋ principal */
const inOrg = ref(":doc/project", ref(":project/org", eq(":org/members")));

const POLICY = {
  version: 1,
  principal: ":user/sub",
  classes: ["anonymous", "member", "admin"],
  ns: {
    doc: {
      read: allow({ _tag: "or", exprs: [eq(":doc/owner"), inOrg] }),
      create: allow(inOrg),
      add: allow(eq(":doc/owner")),
      retract: allow(eq(":doc/owner")),
      retractEntity: allow(eq(":doc/owner")),
    },
    project: { read: allow(ref(":project/org", eq(":org/members"))) },
    org: { read: allow(eq(":org/members")) },
    user: { read: allow(eq(":user/sub", { _tag: "claim", path: ["sub"] })) },
  },
  attrs: { ":doc/audit": { read: allow({ _tag: "class", class: "admin" }) } },
  preset: { ":doc/owner": principal },
};

const attr = (ident: string, type: string, extra: Record<string, unknown> = {}) => ({
  ":db/ident": ident,
  ":db/valueType": `:db.type/${type}`,
  ":db/cardinality": ":db.cardinality/one",
  ...(extra[":db/cardinality"] === ":db.cardinality/many" ? {} : { ":db/optional": true }),
  ...extra,
});

const SCHEMA = [
  attr(":user/sub", "string", { ":db/unique": ":db.unique/identity" }),
  attr(":org/members", "ref", { ":db/cardinality": ":db.cardinality/many" }),
  attr(":project/org", "ref"),
  attr(":doc/title", "string"),
  attr(":doc/owner", "ref"),
  attr(":doc/project", "ref"),
  attr(":doc/audit", "string"),
];

const policyEnv = (extra: Record<string, string | undefined> = {}) => ({
  RAMOSE_POLICY: JSON.stringify(POLICY),
  RAMOSE_JWKS_JSON: JWKS,
  RAMOSE_JWT_ISS: ISS,
  RAMOSE_JWT_AUD: AUD,
  ...extra,
});

interface Fixture {
  peer: Peer;
  eids: Record<string, number>;
}

/** A policed peer serving `acme`, with schema + a doc Ada owns and Carol cannot see. */
async function fixture(extra: Record<string, string | undefined> = {}): Promise<Fixture> {
  const peer = makePeer("acme", { env: policyEnv(extra) });
  await peer.seed(SCHEMA);
  const ack = await peer.seed([
    { ":db/id": "ada", ":user/sub": "user_ada" },
    { ":db/id": "bob", ":user/sub": "user_bob" },
    { ":db/id": "carol", ":user/sub": "user_carol" },
    { ":db/id": "org", ":org/members": ["ada", "bob"] },
    { ":db/id": "proj", ":project/org": "org" },
    { ":db/id": "doc", ":doc/title": "Roadmap", ":doc/owner": "ada", ":doc/project": "proj", ":doc/audit": "read-by-ops" },
    { ":db/id": "solo", ":doc/title": "Carol private", ":doc/owner": "carol" },
  ]);
  return { peer, eids: ack.tempids };
}

const titles = async (peer: Peer, tok?: string) => {
  const { body } = await peer.json("/db/acme/query", post({ query: { find: ["?t"], where: [["?e", ":doc/title", "?t"]] } }, tok));
  return (body.result as string[][]).map((r) => r[0]).sort();
};

// ---------------------------------------------------------------------------

describe("no policy — today's behaviour, unchanged", () => {
  test("no RAMOSE_TOKEN: open, and the demo console is served", async () => {
    const peer = makePeer("demo");
    await peer.seed(SCHEMA);
    expect((await peer.json("/db/demo/query", post({ query: { find: ["?t"], where: [["?e", ":doc/title", "?t"]] } }))).status).toBe(200);
    expect((await peer.fetch("/")).status).toBe(200);
    peer.close();
  });

  test("RAMOSE_TOKEN set: shared-token mode, full access with it and 401 without", async () => {
    const peer = makePeer("demo", { env: { RAMOSE_TOKEN: "s3cret" } });
    await peer.seed(SCHEMA);
    const q = post({ query: { find: ["?t"], where: [["?e", ":doc/title", "?t"]] } });
    expect((await peer.json("/db/demo/query", { ...q, token: "s3cret" })).status).toBe(200);
    expect((await peer.json("/db/demo/query", q)).status).toBe(401);
    expect((await peer.json("/db/demo/query", { ...q, token: "wrong" })).status).toBe(401);
    // the shared token is still admin here: it may write schema
    expect((await peer.json("/db/demo/transact", post({ tx: [attr(":x/y", "string")] }, "s3cret"))).status).toBe(200);
    peer.close();
  });
});

describe("policy configured", () => {
  test("/health is open, the demo console is not served", async () => {
    const { peer } = await fixture();
    expect((await peer.json("/health")).status).toBe(200);
    expect((await peer.fetch("/")).status).toBe(404);
    peer.close();
  });

  test("RAMOSE_TOKEN is not a data-plane principal on a named database", async () => {
    const { peer } = await fixture({ RAMOSE_TOKEN: "s3cret" });
    expect((await peer.json("/health", { token: "s3cret" })).status).toBe(200);
    const q = post({ query: { find: ["?t"], where: [["?e", ":doc/title", "?t"]] } }, "s3cret");
    expect((await peer.json("/db/acme/query", q)).status).toBe(401);
    expect((await peer.json("/db/acme/info", { token: "s3cret" })).status).toBe(401);
    expect((await peer.json("/db/acme/admin/index", { method: "POST", token: "s3cret" })).status).toBe(401);
    // …and it is not a writer either: only an already-deployed `ensure` gets past ingress
    expect((await peer.json("/db/acme/transact", post({ tx: [{ ":doc/title": "by the shared token" }] }, "s3cret"))).status).toBe(401);
    expect(await titles(peer, await token("acme", "admin"))).toEqual(["Carol private", "Roadmap"]);
    peer.close();
  });

  test("a broken verifier denies every /db/* and leaves /health alone", async () => {
    for (const broken of [{ RAMOSE_JWKS_JSON: undefined }, { RAMOSE_JWT_ISS: undefined }, { RAMOSE_JWT_AUD: undefined }, { RAMOSE_POLICY: "{" }]) {
      const peer = makePeer("acme", { env: policyEnv(broken as Record<string, string | undefined>) });
      expect((await peer.json("/health")).status).toBe(200);
      const tok = await token("acme", "admin");
      expect((await peer.json("/db/acme/query", post({ query: { find: ["?t"], where: [["?e", ":doc/title", "?t"]] } }, tok))).status).toBe(401);
      peer.close();
    }
  });

  test("a bound verifier with no policy denies every /db/* and leaves /health alone", async () => {
    const from = events.length;
    const peer = makePeer("acme", {
      env: { RAMOSE_JWKS_JSON: JWKS, RAMOSE_JWT_ISS: ISS, RAMOSE_JWT_AUD: AUD },
    });
    await peer.seed(SCHEMA);
    expect((await peer.json("/health")).status).toBe(200);
    const q = post({ query: { find: ["?t"], where: [["?e", ":doc/title", "?t"]] } });
    expect((await peer.json("/db/acme/query", q)).status).toBe(401);
    expect((await peer.json("/db/acme/transact", post({ tx: [{ ":doc/title": "open?" }] }))).status).toBe(401);
    expect((await peer.json("/db/acme/info")).status).toBe(401);
    expect((await peer.fetch("/")).status).toBe(404);
    const closed = events.slice(from).filter((e) => e.event === "auth.fail-closed");
    expect(closed).toHaveLength(1);
    expect(String(closed[0]!.reason)).toMatch(/RAMOSE_POLICY is not/);
    peer.close();
  });

  /**
   * Deployed, the issuer is usually another Worker on the same account, and
   * Cloudflare answers a Worker→Worker subrequest over `*.workers.dev` with
   * error 1042 (a 404 carrying an HTML body) instead of the key set — so a
   * plain `fetch` of `RAMOSE_JWKS_URL` never returns the JWKS and every token
   * 401s. `RAMOSE_JWKS_SERVICE` names the service binding to dispatch
   * through. Global `fetch` here answers exactly as the edge does, so the
   * test fails if the binding is ever bypassed.
   */
  describe("RAMOSE_JWKS_SERVICE — the issuer is a sibling Worker", () => {
    const JWKS_URL = "https://auth-worker.example.workers.dev/api/auth/jwks";
    const error1042 = () => new Response("error code: 1042\n", { status: 404 });

    const withEdge = async <A,>(run: () => Promise<A>): Promise<A> => {
      const real = globalThis.fetch;
      globalThis.fetch = (() => Promise.resolve(error1042())) as unknown as typeof fetch;
      try {
        return await run();
      } finally {
        globalThis.fetch = real;
      }
    };

    /** The service binding: what `env.AUTH.fetch` hands back, plus a call count. */
    const authBinding = () => {
      const calls: string[] = [];
      return {
        calls,
        fetch: (input: string | Request) => {
          calls.push(typeof input === "string" ? input : input.url);
          return Promise.resolve(new Response(JWKS, { headers: { "content-type": "application/json" } }));
        },
      };
    };

    /** `/info` names the verified caller: 200 once the token verifies, 401 while it does not. */
    const info = async (peer: Peer) =>
      peer.json(`/db/acme/info`, { headers: { authorization: `Bearer ${await token("acme", "admin")}` } });

    /** A peer whose only difference from `fixture()` is where its keys come from. */
    const peerWith = async (env: Record<string, unknown>): Promise<Peer> => {
      const peer = makePeer("acme", { env: env as never });
      await peer.seed(SCHEMA);
      return peer;
    };

    test("the JWKS fetch is dispatched through the named binding", async () => {
      const AUTH = authBinding();
      await withEdge(async () => {
        const peer = await peerWith({ ...policyEnv({ RAMOSE_JWKS_JSON: undefined, RAMOSE_JWKS_URL: JWKS_URL, RAMOSE_JWKS_SERVICE: "AUTH" }), AUTH });
        expect((await info(peer)).status).toBe(200);
        peer.close();
      });
      expect(AUTH.calls).toEqual([JWKS_URL]);
    });

    test("without the binding the same peer 401s — the edge is what it is", async () => {
      await withEdge(async () => {
        const peer = await peerWith(policyEnv({ RAMOSE_JWKS_JSON: undefined, RAMOSE_JWKS_URL: JWKS_URL }));
        expect((await info(peer)).status).toBe(401);
        peer.close();
      });
    });

    test("the reason reaches the logs, so an outage is not just a 401", async () => {
      const from = events.length;
      await withEdge(async () => {
        const peer = await peerWith(policyEnv({ RAMOSE_JWKS_JSON: undefined, RAMOSE_JWKS_URL: JWKS_URL }));
        expect((await info(peer)).status).toBe(401);
        peer.close();
      });
      // the caller learns nothing; the operator learns why — and not the token
      const failed = events.slice(from).filter((e) => e.event === "auth.verify-failed");
      expect(failed).toHaveLength(1);
      expect(String(failed[0]!.reason)).not.toContain("eyJ");
    });

    test("a name that is not a service binding fails closed, it does not fall back to the URL", async () => {
      await withEdge(async () => {
        const peer = await peerWith(policyEnv({ RAMOSE_JWKS_JSON: undefined, RAMOSE_JWKS_URL: JWKS_URL, RAMOSE_JWKS_SERVICE: "NOPE" }));
        expect((await peer.json("/health")).status).toBe(200);
        expect((await info(peer)).status).toBe(401);
        peer.close();
      });
    });
  });

  test("ramose.db is an exact match — nothing else opens another name", async () => {
    const { peer } = await fixture();
    const acme = await token("acme", "member");
    const other = await token("other", "member");
    const q = { query: { find: ["?t"], where: [["?e", ":doc/title", "?t"]] } };
    expect((await peer.json("/db/acme/query", post(q, acme))).status).toBe(200);
    expect((await peer.json("/db/other/query", post(q, acme))).status).toBe(401);
    expect((await peer.json("/db/acme/query", post(q, other))).status).toBe(401);
    peer.close();
  });

  test("wrong aud / iss, an expired token, an over-long TTL and an undeclared class are all 401", async () => {
    const { peer } = await fixture();
    const q = post({ query: { find: ["?t"], where: [["?e", ":doc/title", "?t"]] } });
    const bad = [
      await token("acme", "member", "user_ada", undefined, { aud: "ramose:peer:other" }),
      await token("acme", "member", "user_ada", undefined, { iss: "https://evil.test" }),
      await token("acme", "member", "user_ada", undefined, { iat: Math.floor(Date.now() / 1000) - 600, exp: Math.floor(Date.now() / 1000) - 10 }),
      await token("acme", "member", "user_ada", undefined, { iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 7200 }),
      await token("acme", "root"),
      "not-a-jwt",
    ];
    for (const t of bad) expect((await peer.json("/db/acme/query", { ...q, token: t })).status).toBe(401);
    // and the good one still works
    expect((await peer.json("/db/acme/query", { ...q, token: await token("acme", "member") })).status).toBe(200);
    peer.close();
  });

  test("no token is the anonymous class (which this policy grants nothing)", async () => {
    const { peer } = await fixture();
    const { status, body } = await peer.json("/db/acme/query", post({ query: { find: ["?t"], where: [["?e", ":doc/title", "?t"]] } }));
    expect(status).toBe(200);
    expect(body.result).toEqual([]);
    peer.close();
  });

  test("no token is 401 when the policy declares no anonymous class", async () => {
    const closed = { ...POLICY, classes: ["member", "admin"] };
    const peer = makePeer("acme", { env: policyEnv({ RAMOSE_POLICY: JSON.stringify(closed) }) });
    await peer.seed(SCHEMA);
    expect((await peer.json("/db/acme/query", post({ query: { find: ["?t"], where: [["?e", ":doc/title", "?t"]] } }))).status).toBe(401);
    peer.close();
  });
});

describe("reads are a filtered Db", () => {
  test("a query only sees what the rules allow, per principal", async () => {
    const { peer } = await fixture();
    expect(await titles(peer, await token("acme", "member", "user_ada"))).toEqual(["Roadmap"]);
    expect(await titles(peer, await token("acme", "member", "user_carol"))).toEqual(["Carol private"]);
    expect(await titles(peer, await token("acme", "admin", "user_ada"))).toEqual(["Carol private", "Roadmap"]);
    peer.close();
  });

  test("a variable attribute ([?e ?a ?v]) is filtered too — :doc/audit is admin-only", async () => {
    const { peer, eids } = await fixture();
    const values = async (tok: string) => {
      const { body } = await peer.json("/db/acme/query", post({ query: { find: ["?v"], where: [[eids.doc, "?a", "?v"]] } }, tok));
      return (body.result as unknown[][]).map((r) => r[0]);
    };
    const member = await values(await token("acme", "member", "user_ada"));
    expect(member).toContain("Roadmap");
    expect(member).not.toContain("read-by-ops");
    expect(await values(await token("acme", "admin"))).toContain("read-by-ops");
    peer.close();
  });

  test("pull redacts a masked attribute; entity and pull of an invisible entity come back empty", async () => {
    const { peer, eids } = await fixture();
    const member = await token("acme", "member", "user_ada");
    const pulled = await peer.json("/db/acme/pull", post({ eid: eids.doc, pattern: [":doc/title", ":doc/audit"] }, member));
    expect(pulled.body.result[":doc/title"]).toBe("Roadmap");
    expect(pulled.body.result[":doc/audit"]).toBeUndefined();

    const hidden = await peer.json("/db/acme/pull", post({ eid: eids.solo, pattern: [":doc/title"] }, member));
    expect(hidden.body.result?.[":doc/title"]).toBeUndefined();
    const entity = await peer.json(`/db/acme/entity/${eids.solo}`, { token: member });
    expect(entity.body.entity?.[":doc/title"]).toBeUndefined();
    peer.close();
  });

  test("asOf reads the data at t but the rules at the current basis", async () => {
    const { peer, eids } = await fixture();
    const member = await token("acme", "member", "user_ada");
    const at = await peer.json("/db/acme/query", post({ query: { find: ["?t"], where: [["?e", ":doc/title", "?t"]] }, asOf: 3 }, member));
    expect(at.status).toBe(200);
    expect(at.body.result).toEqual([["Roadmap"]]);
    expect(eids.doc).toBeGreaterThan(0);
    peer.close();
  });
});

describe("writes", () => {
  // Policy on raw `/transact` — specifically `writes: "all"`. Under the
  // default a member data write is 403 `code: "operations"` before checkWrite.
  const raw = () => fixture({ RAMOSE_WRITES: "all" });

  test("a denied write fails at ingress with 403 { code: policy } and no values", async () => {
    const { peer, eids } = await raw();
    const carol = await token("acme", "member", "user_carol");
    const { status, body } = await peer.json("/db/acme/transact", post({ tx: [[":db/add", eids.doc, ":doc/title", "hacked"]] }, carol));
    expect(status).toBe(403);
    expect(body.code).toBe("policy");
    expect(body.attr).toBe(":doc/title");
    expect(JSON.stringify(body)).not.toContain("hacked");
    expect(await titles(peer, await token("acme", "member", "user_ada"))).toEqual(["Roadmap"]);
    peer.close();
  });

  test("the owner may write, and `create` injects the preset owner", async () => {
    const { peer, eids } = await raw();
    const ada = await token("acme", "member", "user_ada");
    expect((await peer.json("/db/acme/transact", post({ tx: [[":db/add", eids.doc, ":doc/title", "Roadmap v2"]] }, ada))).status).toBe(200);
    expect(await titles(peer, ada)).toEqual(["Roadmap v2"]);

    const created = await peer.json("/db/acme/transact", post({ tx: [{ ":db/id": "new", ":doc/title": "Spec", ":doc/project": eids.proj }] }, ada));
    expect(created.status).toBe(200);
    expect(Array.isArray(created.body.datoms)).toBe(true);
    expect(created.body.datoms.length).toBeGreaterThan(0);
    const owner = await peer.json("/db/acme/pull", post({ eid: created.body.tempids.new, pattern: [":doc/title", ":doc/owner"] }, ada));
    expect(owner.body.result[":doc/owner"]).toEqual({ ":db/id": eids.ada });

    const first = await peer.json("/db/acme/transact", post({ tx: [{ ":db/id": "again", ":doc/title": "Idempotent", ":doc/project": eids.proj }], clientTxId: "c1" }, ada));
    expect(first.status).toBe(200);
    const replay = await peer.json("/db/acme/transact", post({ tx: [{ ":db/id": "again", ":doc/title": "Idempotent", ":doc/project": eids.proj }], clientTxId: "c1" }, ada));
    expect(replay.status).toBe(200);
    expect(replay.body.t).toBe(first.body.t);
    expect(replay.body.datoms).toEqual(first.body.datoms);
    expect(await titles(peer, ada)).toEqual(["Idempotent", "Roadmap v2", "Spec"]);
    peer.close();
  });

  test("a client-supplied preset value that is not the peer's is denied", async () => {
    const { peer, eids } = await raw();
    const ada = await token("acme", "member", "user_ada");
    const res = await peer.json("/db/acme/transact", post({ tx: [{ ":doc/title": "Spec", ":doc/project": eids.proj, ":doc/owner": eids.bob }] }, ada));
    expect(res.status).toBe(403);
    expect(res.body.attr).toBe(":doc/owner");
    peer.close();
  });

  test("`create` outside the principal's org is denied", async () => {
    const { peer, eids } = await raw();
    const carol = await token("acme", "member", "user_carol");
    expect((await peer.json("/db/acme/transact", post({ tx: [{ ":doc/title": "Spec", ":doc/project": eids.proj }] }, carol))).status).toBe(403);
    peer.close();
  });

  test("admin bypasses the check entirely", async () => {
    const { peer, eids } = await raw();
    const admin = await token("acme", "admin", "user_ops");
    expect((await peer.json("/db/acme/transact", post({ tx: [[":db/add", eids.solo, ":doc/title", "renamed"]] }, admin))).status).toBe(200);
    peer.close();
  });
});

describe("ensure and privileged surfaces", () => {
  test("a non-admin's ensure of an already-deployed subset is skipped silently; a new ident is 403", async () => {
    const { peer } = await fixture({ RAMOSE_TOKEN: "s3cret" });
    const member = await token("acme", "member");
    const subset = { tx: [attr(":doc/title", "string"), attr(":user/sub", "string", { ":db/unique": ":db.unique/identity" })] };
    for (const tok of [member, "s3cret"]) {
      const res = await peer.json("/db/acme/transact", post(subset, tok));
      expect(res.status).toBe(200);
      expect(res.body.datoms).toEqual([]);
      expect(res.body.code).not.toBe("operations");
    }
    const fresh = await peer.json("/db/acme/transact", post({ tx: [attr(":doc/secret", "string")] }, member));
    expect(fresh.status).toBe(403);
    expect(fresh.body.code).toBe("policy");
    expect(fresh.body.attr).toBe(":doc/secret");
    // …and an admin actually installs it
    expect((await peer.json("/db/acme/transact", post({ tx: [attr(":doc/secret", "string")] }, await token("acme", "admin")))).status).toBe(200);
    peer.close();
  });

  test("explain and /admin/* are admin-only; /info reduces to { db, t, principal }", async () => {
    const { peer } = await fixture();
    const member = await token("acme", "member");
    const admin = await token("acme", "admin");
    const q = { query: { find: ["?t"], where: [["?e", ":doc/title", "?t"]] }, explain: true };
    expect((await peer.json("/db/acme/query", post(q, member))).status).toBe(403);
    expect((await peer.json("/db/acme/query", post(q, admin))).status).toBe(200);
    expect((await peer.json("/db/acme/admin/index", { method: "POST", token: member })).status).toBe(403);
    expect((await peer.json("/db/acme/admin/index", { method: "POST", token: admin })).status).toBe(200);

    const info = await peer.json("/db/acme/info", { token: member });
    expect(Object.keys(info.body).sort()).toEqual(["db", "principal", "t"]);
    expect(typeof info.body.t).toBe("number");
    // one shape: the admin answer carries the same top-level `t`, plus the internals
    const adminInfo = await peer.json("/db/acme/info", { token: admin });
    expect(typeof adminInfo.body.t).toBe("number");
    expect(adminInfo.body.t).toBe(info.body.t);
    expect(adminInfo.body.transactor).toBeDefined();
    expect(typeof adminInfo.body.transactor.t).toBe("number");
    peer.close();
  });

  test("/info tells the caller who it is: sub → eid via the policy's principal attribute", async () => {
    const { peer, eids } = await fixture();
    // a member whose row exists: the eid, resolved on the peer
    const ada = await peer.json("/db/acme/info", { token: await token("acme", "member", "user_ada") });
    expect(ada.body.principal).toEqual({ eid: eids.ada, class: "member" });
    // informational, so an admin's sub resolves too (filtering exemption is separate)
    const admin = await peer.json("/db/acme/info", { token: await token("acme", "admin", "user_bob") });
    expect(admin.body.principal).toEqual({ eid: eids.bob, class: "admin" });
    // no token: the anonymous class has no sub, so no entity
    const anon = await peer.json("/db/acme/info");
    expect(anon.body.principal).toEqual({ eid: null, class: "anonymous" });
    peer.close();
  });

  test("the peer provisions the principal row on first /info — and re-entry is the same eid", async () => {
    const { peer } = await fixture();
    const zoe = await token("acme", "member", "user_zoe");
    const first = await peer.json("/db/acme/info", { token: zoe });
    expect(first.body.principal.class).toBe("member");
    expect(first.body.principal.eid).toBeGreaterThan(0);
    const again = await peer.json("/db/acme/info", { token: zoe });
    expect(again.body.principal).toEqual(first.body.principal);
    // one entity for that sub — unique-identity upsert, not a second create
    const { body } = await peer.json(
      "/db/acme/query",
      post({ query: { find: ["?e"], where: [["?e", ":user/sub", "user_zoe"]] } }, await token("acme", "admin")),
    );
    expect(body.result).toEqual([[first.body.principal.eid]]);
    peer.close();
  });

  test("a first-session write provisions before the client tx is authorized", async () => {
    const { peer } = await fixture();
    const zoeTok = await token("acme", "admin", "user_zoe");
    const write = await peer.json("/db/acme/transact", post({ tx: [{ ":doc/title": "Zoe's first" }] }, zoeTok));
    expect(write.status).toBe(200);
    const info = await peer.json("/db/acme/info", { token: zoeTok });
    expect(info.body.principal.eid).toBeGreaterThan(0);
    const { body } = await peer.json(
      "/db/acme/query",
      post({ query: { find: ["?e"], where: [["?e", ":user/sub", "user_zoe"]] } }, zoeTok),
    );
    expect(body.result).toEqual([[info.body.principal.eid]]);
    peer.close();
  });

  test("anonymous and service principals stay unresolved", async () => {
    const { peer } = await fixture({ RAMOSE_TOKEN: "s3cret" });
    const anon = await peer.json("/db/acme/info");
    expect(anon.body.principal).toEqual({ eid: null, class: "anonymous" });
    expect((await peer.json("/db/acme/info", { token: "s3cret" })).status).toBe(401);
    const { body } = await peer.json(
      "/db/acme/query",
      post({ query: { find: ["?e"], where: [["?e", ":user/sub", "s3cret"]] } }, await token("acme", "admin")),
    );
    expect(body.result).toEqual([]);
    peer.close();
  });

  test("User.role is materialized from the token class and updates on re-entry", async () => {
    const peer = makePeer("acme", { env: policyEnv() });
    await peer.seed([
      ...SCHEMA,
      { ":db/ident": ":user/role", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/optional": true },
    ]);
    const member = await token("acme", "member", "user_ida");
    const first = await peer.json("/db/acme/info", { token: member });
    expect(first.body.principal.class).toBe("member");
    const eid = first.body.principal.eid as number;
    expect(eid).toBeGreaterThan(0);
    const pulled = await peer.json("/db/acme/pull", post({ eid, pattern: [":user/sub", ":user/role"] }, member));
    expect(pulled.body.result).toMatchObject({ ":user/sub": "user_ida", ":user/role": "member" });

    // a new class is the same upsert — one entity, new role fact
    const asAdmin = await token("acme", "admin", "user_ida");
    const promoted = await peer.json("/db/acme/info", { token: asAdmin });
    expect(promoted.body.principal).toEqual({ eid, class: "admin" });
    const after = await peer.json("/db/acme/pull", post({ eid, pattern: [":user/sub", ":user/role"] }, asAdmin));
    expect(after.body.result).toMatchObject({ ":user/sub": "user_ida", ":user/role": "admin" });
    peer.close();
  });

  test("ramose.attrs name/email materialize on first /info and update on change", async () => {
    const peer = makePeer("acme", { env: policyEnv() });
    await peer.seed([
      ...SCHEMA,
      { ":db/ident": ":user/role", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/optional": true },
      { ":db/ident": ":user/name", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/optional": true },
      { ":db/ident": ":user/email", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/optional": true },
    ]);
    const firstTok = await token("acme", "member", "user_zoe", { name: "Zoe", email: "zoe@acme.test" });
    const first = await peer.json("/db/acme/info", { token: firstTok });
    const eid = first.body.principal.eid as number;
    expect(eid).toBeGreaterThan(0);
    const pulled = await peer.json(
      "/db/acme/pull",
      post({ eid, pattern: [":user/sub", ":user/role", ":user/name", ":user/email"] }, firstTok),
    );
    expect(pulled.body.result).toMatchObject({
      ":user/sub": "user_zoe",
      ":user/role": "member",
      ":user/name": "Zoe",
      ":user/email": "zoe@acme.test",
    });

    const renamed = await token("acme", "member", "user_zoe", { name: "Zoe Ames", email: "zoe@acme.test" });
    const again = await peer.json("/db/acme/info", { token: renamed });
    expect(again.body.principal).toEqual({ eid, class: "member" });
    const after = await peer.json(
      "/db/acme/pull",
      post({ eid, pattern: [":user/name", ":user/email"] }, renamed),
    );
    expect(after.body.result).toMatchObject({ ":user/name": "Zoe Ames", ":user/email": "zoe@acme.test" });
    peer.close();
  });

  test("no policy: /info still names the caller — class admin, no entity to resolve", async () => {
    const peer = makePeer("demo");
    await peer.seed(SCHEMA);
    const info = await peer.json("/db/demo/info");
    expect(info.body.principal).toEqual({ eid: null, class: "admin" });
    peer.close();
  });

  test("admin /info is not 200 while the transactor answers Worker not found", async () => {
    const peer = makePeer("demo");
    await peer.seed(SCHEMA);
    (peer.env as { TRANSACTOR: unknown }).TRANSACTOR = {
      idFromName: (name: string) => ({ name, toString: () => name }),
      get: () => ({
        fetch: async () => new Response(JSON.stringify({ error: "Worker not found." }), { status: 500 }),
      }),
    };
    const info = await peer.json("/db/demo/info");
    expect(info.status).toBe(500);
    expect(info.body).toEqual({ error: "Worker not found." });
    peer.close();
  });

  test("CORS narrows to RAMOSE_ALLOWED_ORIGINS once a policy is configured", async () => {
    const { peer } = await fixture({ RAMOSE_ALLOWED_ORIGINS: "https://app.acme.test" });
    const ok = await peer.fetch("/health", { headers: { origin: "https://app.acme.test" } });
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://app.acme.test");
    const nope = await peer.fetch("/health", { headers: { origin: "https://evil.test" } });
    expect(nope.headers.get("access-control-allow-origin")).toBeNull();
    peer.close();
  });
});

describe("the Worker→DO internal secret", () => {
  test("the DOs refuse a fetch that does not carry it, and the Worker's own always does", async () => {
    const { peer } = await fixture({ RAMOSE_INTERNAL_SECRET: "deploy-minted" });
    expect((await peer.transactorFetch("/info?db=acme")).status).toBe(401);
    expect((await peer.replicaFetch("/basis?db=acme")).status).toBe(401);
    expect((await peer.transactorFetch("/info?db=acme", { headers: { "x-ramose-internal": "deploy-minted" } })).status).toBe(200);
    // the Worker reaches both on every read, so a working query proves it forwards the header
    expect(await titles(peer, await token("acme", "member", "user_ada"))).toEqual(["Roadmap"]);
    peer.close();
  });

  test("unset = today's behaviour", async () => {
    const { peer } = await fixture();
    expect((await peer.transactorFetch("/info?db=acme")).status).toBe(200);
    peer.close();
  });
});
