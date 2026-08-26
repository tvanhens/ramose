/**
 * Public `/op` and `/pull` behavior against a real peer.
 */

import { describe, expect, test } from "bun:test";
import { schemaTx } from "../../packages/ramose/src/db/ensure.ts";
import { signToken } from "../../packages/ramose/test/sign-local-token.ts";
import { json, post, seedTx, uniqueDb, type LocalUrls } from "../local/fixtures.ts";
import { Movies, OPERATION_IDS } from "../local/ops.ts";

export interface OperationsTarget {
  readonly urls: () => LocalUrls;
}

const titles = async (base: string, db: string, tok?: string) => {
  const { body } = await json(
    base,
    `/db/${encodeURIComponent(db)}/query`,
    post({ query: { find: ["?t"], where: [["?e", ":movie/title", "?t"]] } }, tok),
  );
  return ((body.result as string[][]) ?? []).map((r) => r[0]).sort();
};

const seedMovies = (base: string, db: string, token?: string) =>
  seedTx(base, db, schemaTx(Movies) as unknown[], token);

export function registerOperationsContract(target: OperationsTarget): void {
  describe("GET /health lists registered operation ids", () => {
    test("the peer reports the registry it was built with", async () => {
      const { openUrl } = target.urls();
      const { status, body } = await json(openUrl, "/health");
      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.operations).toEqual(OPERATION_IDS);
    });

    test("an empty registry reports an empty list", async () => {
      const { emptyUrl } = target.urls();
      const { body } = await json(emptyUrl, "/health");
      expect(body.operations).toEqual([]);
    });
  });

  describe("POST /db/:name/op", () => {
    test("unknown name is 400, not 409", async () => {
      const { openUrl } = target.urls();
      const db = uniqueDb("movies");
      await seedMovies(openUrl, db);
      const { status, body } = await json(openUrl, `/db/${db}/op`, post({ name: "nope", input: {} }));
      expect(status).toBe(400);
      expect(String(body.error)).toContain("unknown operation");
    });

    test("invalid input is 400", async () => {
      const { openUrl } = target.urls();
      const db = uniqueDb("movies");
      await seedMovies(openUrl, db);
      const { status } = await json(
        openUrl,
        `/db/${db}/op`,
        post({ name: "movie/set-title", entity: 1, input: { title: 9 } }),
      );
      expect(status).toBe(400);
    });

    test("contextual entity: dangling and foreign-namespace are 409 before effects", async () => {
      const { openUrl } = target.urls();
      const db = uniqueDb("movies");
      await seedMovies(openUrl, db);
      const seed = await seedTx(openUrl, db, [
        { ":db/id": "ada", ":user/name": "Ada" },
        { ":db/id": "heat", ":movie/title": "Heat" },
      ]);
      const ada = seed.tempids.ada!;
      const heat = seed.tempids.heat!;

      const dangling = await json(
        openUrl,
        `/db/${db}/op`,
        post({
          name: "movie/set-title",
          entity: 9_999_999,
          input: { title: "x" },
          clientOpId: "op-dangle",
        }),
      );
      expect(dangling.status).toBe(409);
      expect(dangling.body.tag).toBe("OperationRejected");
      expect(dangling.body.reason).toBe("dangling");

      const foreign = await json(
        openUrl,
        `/db/${db}/op`,
        post({
          name: "movie/set-title",
          entity: ada,
          input: { title: "x" },
          clientOpId: "op-foreign",
        }),
      );
      expect(foreign.status).toBe(409);
      expect(foreign.body.reason).toBe("foreign");

      const ok = await json(
        openUrl,
        `/db/${db}/op`,
        post({
          name: "movie/set-title",
          entity: heat,
          input: { title: "Heat (1995)" },
          clientOpId: "op-ok",
        }),
      );
      expect(ok.status).toBe(200);
      expect(ok.body.output).toEqual({ title: "Heat (1995)" });
      expect(await titles(openUrl, db)).toEqual(["Heat (1995)"]);
    });

    test("a lookup-shaped entity resolves when the row exists and is dangling when it does not", async () => {
      const { openUrl } = target.urls();
      const db = uniqueDb("movies");
      await seedMovies(openUrl, db);
      await seedTx(openUrl, db, [{ ":user/name": "Ada" }]);

      const missing = await json(
        openUrl,
        `/db/${db}/op`,
        post({
          name: "user/set-name",
          entity: [":user/name", "Missing"],
          input: { name: "Nope" },
          clientOpId: "op-lookup-miss",
        }),
      );
      expect(missing.status).toBe(409);
      expect(missing.body.reason).toBe("dangling");

      const ok = await json(
        openUrl,
        `/db/${db}/op`,
        post({
          name: "user/set-name",
          entity: [":user/name", "Ada"],
          input: { name: "Ada Lovelace" },
          clientOpId: "op-lookup-ok",
        }),
      );
      expect(ok.status).toBe(200);
      expect(ok.body.output).toEqual({ name: "Ada Lovelace" });
    });

    test("the same clientOpId replays the original ack and does not re-run effects", async () => {
      const { openUrl } = target.urls();
      const db = uniqueDb("movies");
      await seedMovies(openUrl, db);
      const first = await json(
        openUrl,
        `/db/${db}/op`,
        post({ name: "ping", input: {}, clientOpId: "op-ping" }),
      );
      expect(first.status).toBe(200);
      expect(first.body.output).toEqual({ n: 1 });
      const t = first.body.t as number;
      const second = await json(
        openUrl,
        `/db/${db}/op`,
        post({ name: "ping", input: {}, clientOpId: "op-ping" }),
      );
      expect(second.status).toBe(200);
      expect(second.body.t).toBe(t);
      expect(second.body.output).toEqual({ n: 1 });
    });

    test("a write op replay keeps t and does not insert a second row", async () => {
      const { openUrl } = target.urls();
      const db = uniqueDb("movies");
      await seedMovies(openUrl, db);
      const first = await json(
        openUrl,
        `/db/${db}/op`,
        post({ name: "user/create", input: { name: "Ada" }, clientOpId: "op-ada" }),
      );
      expect(first.status).toBe(200);
      const second = await json(
        openUrl,
        `/db/${db}/op`,
        post({ name: "user/create", input: { name: "Ada" }, clientOpId: "op-ada" }),
      );
      expect(second.status).toBe(200);
      expect(second.body.t).toBe(first.body.t);
      const { body } = await json(
        openUrl,
        `/db/${db}/query`,
        post({ query: { find: ["?n"], where: [["?e", ":user/name", "?n"]] } }),
      );
      expect((body.result as string[][]).map((r) => r[0])).toEqual(["Ada"]);
    });

    test("a clientOpId replay returns the same encoded output as the first commit", async () => {
      const { openUrl } = target.urls();
      const db = uniqueDb("movies");
      await seedMovies(openUrl, db);
      const first = await json(
        openUrl,
        `/db/${db}/op`,
        post({ name: "user/create-coded", input: { name: "Ada" }, clientOpId: "op-coded" }),
      );
      expect(first.status).toBe(200);
      const firstOut = first.body.output as { id: unknown; code: unknown };
      expect(typeof firstOut.id).toBe("number");
      expect(firstOut.code).toBe("5");
      const second = await json(
        openUrl,
        `/db/${db}/op`,
        post({ name: "user/create-coded", input: { name: "Ada" }, clientOpId: "op-coded" }),
      );
      expect(second.status).toBe(200);
      expect(second.body.t).toBe(first.body.t);
      expect(second.body.output).toEqual(first.body.output);
    });

    test("put with a unique field unifies a second write onto the same row", async () => {
      const { openUrl } = target.urls();
      const db = uniqueDb("movies");
      await seedMovies(openUrl, db);
      await json(
        openUrl,
        `/db/${db}/op`,
        post({ name: "user/create-put", input: { name: "Ada" }, clientOpId: "op-put" }),
      );
      await json(
        openUrl,
        `/db/${db}/op`,
        post({ name: "user/create-put", input: { name: "Ada" }, clientOpId: "op-put-again" }),
      );
      const { body } = await json(
        openUrl,
        `/db/${db}/query`,
        post({ query: { find: ["?e"], where: [["?e", ":user/name", "Ada"]] } }),
      );
      expect((body.result as unknown[][]).length).toBe(1);
    });

    test("app-class token is denied on /transact; /op works; admin keeps /transact", async () => {
      const { policyUrl } = target.urls();
      const db = uniqueDb("movies");
      const admin = await signToken(db, "admin");
      await seedMovies(policyUrl, db, admin);
      await seedTx(policyUrl, db, [{ ":user/name": "user_ada" }], admin);
      const member = await signToken(db, "member");

      const denied = await json(
        policyUrl,
        `/db/${db}/transact`,
        post({ tx: [{ ":movie/title": "raw" }] }, member),
      );
      expect(denied.status).toBe(403);
      expect(denied.body.code).toBe("operations");

      const asAdmin = await json(
        policyUrl,
        `/db/${db}/transact`,
        post({ tx: [{ ":movie/title": "admin-write" }] }, admin),
      );
      expect(asAdmin.status).toBe(200);

      const viaOp = await json(
        policyUrl,
        `/db/${db}/op`,
        post({ name: "user/create", input: { name: "Bea" }, clientOpId: "op-bea" }, member),
      );
      expect(viaOp.status).toBe(200);
    });

    test("put missing a required field is 409 TxRejected tx/required", async () => {
      const { openUrl } = target.urls();
      const db = uniqueDb("movies");
      await seedMovies(openUrl, db);
      const { status, body } = await json(
        openUrl,
        `/db/${db}/op`,
        post({ name: "user/create-short", input: {}, clientOpId: "op-short" }),
      );
      expect(status).toBe(409);
      expect(body.tag).toBe("TxRejected");
      expect(body.code).toBe("tx/required");
    });

    test("update of a missing row is 409 TxRejected tx/missing-entity", async () => {
      const { openUrl } = target.urls();
      const db = uniqueDb("movies");
      await seedMovies(openUrl, db);
      const { status, body } = await json(
        openUrl,
        `/db/${db}/op`,
        post({ name: "user/update-ghost", input: {}, clientOpId: "op-ghost" }),
      );
      expect(status).toBe(409);
      expect(body.code).toBe("tx/missing-entity");
    });

    test("H1 put on bootstrap eid is 409 TxRejected tx/required", async () => {
      const { openUrl } = target.urls();
      const db = uniqueDb("movies");
      await seedMovies(openUrl, db);
      const { status, body } = await json(
        openUrl,
        `/db/${db}/op`,
        post({ name: "user/put-bootstrap", input: {}, clientOpId: "op-h1" }),
      );
      expect(status).toBe(409);
      expect(body.code).toBe("tx/required");
    });

    test("H2 put onto another namespace is 409 TxRejected tx/wrong-entity", async () => {
      const { openUrl } = target.urls();
      const db = uniqueDb("movies");
      await seedMovies(openUrl, db);
      const seeded = await seedTx(openUrl, db, [{ ":db/id": "heat", ":movie/title": "Heat" }]);
      const { status, body } = await json(
        openUrl,
        `/db/${db}/op`,
        post({
          name: "user/put-on-movie",
          input: { eid: seeded.tempids.heat },
          clientOpId: "op-h2",
        }),
      );
      expect(status).toBe(409);
      expect(body.code).toBe("tx/wrong-entity");
    });

    test("H3 put at a nonexistent eid is 409 TxRejected tx/missing-entity", async () => {
      const { openUrl } = target.urls();
      const db = uniqueDb("movies");
      await seedMovies(openUrl, db);
      const { status, body } = await json(
        openUrl,
        `/db/${db}/op`,
        post({ name: "user/put-missing-eid", input: {}, clientOpId: "op-h3" }),
      );
      expect(status).toBe(409);
      expect(body.code).toBe("tx/missing-entity");
    });

    test("H4 dangling ref is 409 TxRejected tx/missing-entity", async () => {
      const { openUrl } = target.urls();
      const db = uniqueDb("movies");
      await seedMovies(openUrl, db);
      const { status, body } = await json(
        openUrl,
        `/db/${db}/op`,
        post({ name: "user/put-dangling-ref", input: {}, clientOpId: "op-h4" }),
      );
      expect(status).toBe(409);
      expect(body.code).toBe("tx/missing-entity");
    });
  });

  describe("pull against an uninstalled attribute", () => {
    test("is a 400, and names the attribute", async () => {
      const { openUrl } = target.urls();
      const db = uniqueDb("acme");
      await seedTx(openUrl, db, [
        {
          ":db/ident": ":doc/title",
          ":db/valueType": ":db.type/string",
          ":db/cardinality": ":db.cardinality/one",
          ":db/optional": true,
        },
      ]);
      const seeded = await seedTx(openUrl, db, [{ ":db/id": "doc", ":doc/title": "Roadmap" }]);
      const eid = seeded.tempids.doc;
      const ok = await json(openUrl, `/db/${db}/pull`, post({ eid, pattern: [":doc/title"] }));
      expect(ok.status).toBe(200);
      expect(ok.body.result[":doc/title"]).toBe("Roadmap");
      const bad = await json(
        openUrl,
        `/db/${db}/pull`,
        post({ eid, pattern: [":doc/title", ":doc/nope"] }),
      );
      expect(bad.status).toBe(400);
      expect(bad.body.error).toContain(":doc/nope");
      const query = await json(
        openUrl,
        `/db/${db}/query`,
        post({ query: { find: ["?e"], where: [["?e", ":doc/nope", "?v"]] } }),
      );
      expect(query.status).toBe(400);
    });

    test("the check follows nested sub-patterns and collection :where / :order", async () => {
      const { openUrl } = target.urls();
      const db = uniqueDb("acme");
      await seedTx(openUrl, db, [
        {
          ":db/ident": ":doc/title",
          ":db/valueType": ":db.type/string",
          ":db/cardinality": ":db.cardinality/one",
          ":db/optional": true,
        },
        {
          ":db/ident": ":doc/author",
          ":db/valueType": ":db.type/ref",
          ":db/cardinality": ":db.cardinality/one",
          ":db/optional": true,
        },
      ]);
      const bad = await json(
        openUrl,
        `/db/${db}/pull`,
        post({
          eid: 1,
          pattern: [
            {
              kind: "attr",
              attr: ":doc/author",
              reverse: false,
              as: "author",
              sub: [{ kind: "attr", attr: ":user/ghost", reverse: false, as: "ghost" }],
            },
          ],
        }),
      );
      expect(bad.status).toBe(400);
      expect(bad.body.error).toContain(":user/ghost");

      const where = await json(
        openUrl,
        `/db/${db}/pull`,
        post({
          eid: 1,
          pattern: [
            {
              kind: "attr",
              attr: ":doc/author",
              reverse: false,
              as: "author",
              where: [
                {
                  or: [
                    { path: [":doc/title"], op: "exists" },
                    { not: { path: [":user/ghost"], op: "exists" } },
                  ],
                },
              ],
              sub: [":doc/title"],
            },
          ],
        }),
      );
      expect(where.status).toBe(400);
      expect(where.body.error).toContain(":user/ghost");
    });

    test("`*` and `:db/id` are not attributes, so they pass", async () => {
      const { openUrl } = target.urls();
      const db = uniqueDb("acme");
      await seedTx(openUrl, db, [
        {
          ":db/ident": ":doc/title",
          ":db/valueType": ":db.type/string",
          ":db/cardinality": ":db.cardinality/one",
          ":db/optional": true,
        },
      ]);
      const seeded = await seedTx(openUrl, db, [{ ":db/id": "doc", ":doc/title": "Ship it" }]);
      const wild = await json(openUrl, `/db/${db}/pull`, post({ eid: seeded.tempids.doc, pattern: ["*"] }));
      expect(wild.status).toBe(200);
      expect(wild.body.result[":doc/title"]).toBe("Ship it");
    });
  });
}
