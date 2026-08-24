/**
 * `POST /db/:name/pull` against an attribute the database has never installed.
 *
 * The pull engine is deliberately lenient — an unknown attribute is skipped
 * rather than thrown on (Datomic throws) — which made a pull against an
 * uninstalled database return a silent subset while the same query would fail
 * `InvalidRequest`. The API contract is that both are `InvalidRequest`, so the
 * route checks the pattern against the schema before it runs.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { makePeer, post } from "./harness.ts";

const peer = makePeer("acme");
afterAll(() => peer.close());

const attr = (ident: string, type: string) => ({
  ":db/ident": ident,
  ":db/valueType": `:db.type/${type}`,
  ":db/cardinality": ":db.cardinality/one",
  ":db/optional": true,
});

describe("pull against an uninstalled attribute", () => {
  test("is a 400, and names the attribute", async () => {
    await peer.seed([attr(":doc/title", "string")]);
    const seeded = await peer.seed([{ ":db/id": "doc", ":doc/title": "Roadmap" }]);
    const eid = seeded.tempids.doc;

    // installed: the value comes back
    const ok = await peer.json(
      "/db/acme/pull",
      post({ eid, pattern: [":doc/title"] }),
    );
    expect(ok.status).toBe(200);
    expect(ok.body.result[":doc/title"]).toBe("Roadmap");

    // never installed: a refusal, not a subset
    const bad = await peer.json(
      "/db/acme/pull",
      post({ eid, pattern: [":doc/title", ":doc/nope"] }),
    );
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain(":doc/nope");

    // …exactly as the same attribute in a query is
    const query = await peer.json(
      "/db/acme/query",
      post({ query: { find: ["?e"], where: [["?e", ":doc/nope", "?v"]] } }),
    );
    expect(query.status).toBe(400);
  });

  test("the check follows nested sub-patterns", async () => {
    await peer.seed([
      { ":db/ident": ":doc/author", ":db/valueType": ":db.type/ref", ":db/cardinality": ":db.cardinality/one", ":db/optional": true },
    ]);
    const bad = await peer.json(
      "/db/acme/pull",
      post({
        eid: 1,
        pattern: [
          { kind: "attr", attr: ":doc/author", reverse: false, as: "author", sub: [{ kind: "attr", attr: ":user/ghost", reverse: false, as: "ghost" }] },
        ],
      }),
    );
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain(":user/ghost");
  });

  test("…and the paths a nested collection's :where / :order walk", async () => {
    const where = await peer.json(
      "/db/acme/pull",
      post({
        eid: 1,
        pattern: [
          {
            kind: "attr",
            attr: ":doc/author",
            reverse: false,
            as: "author",
            where: [{ or: [{ path: [":doc/title"], op: "exists" }, { not: { path: [":user/ghost"], op: "exists" } }] }],
            sub: [":doc/title"],
          },
        ],
      }),
    );
    expect(where.status).toBe(400);
    expect(where.body.error).toContain(":user/ghost");

    const order = await peer.json(
      "/db/acme/pull",
      post({
        eid: 1,
        pattern: [
          {
            kind: "attr",
            attr: ":doc/author",
            reverse: false,
            as: "author",
            order: [{ path: [":db/id"], dir: "asc" }, { path: [":user/phantom"], dir: "desc" }],
            sub: [":doc/title"],
          },
        ],
      }),
    );
    expect(order.status).toBe(400);
    expect(order.body.error).toContain(":user/phantom");

    // a nested where over installed attributes is not a bad request
    const ok = await peer.json(
      "/db/acme/pull",
      post({
        eid: 1,
        pattern: [
          {
            kind: "attr",
            attr: ":doc/author",
            reverse: false,
            as: "author",
            where: [{ path: [":doc/title"], op: "exists" }],
            order: [{ path: [":doc/title"], dir: "asc" }],
            sub: [":doc/title"],
          },
        ],
      }),
    );
    expect(ok.status).toBe(200);
  });

  test("`*` and `:db/id` are not attributes, so they pass", async () => {
    const seeded = await peer.seed([{ ":db/id": "doc", ":doc/title": "Ship it" }]);
    const wild = await peer.json(
      "/db/acme/pull",
      post({ eid: seeded.tempids.doc, pattern: ["*"] }),
    );
    expect(wild.status).toBe(200);
    expect(wild.body.result[":doc/title"]).toBe("Ship it");
  });
});
