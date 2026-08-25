/**
 * Peer `/op`: resolve, decode, contextual entity checks, idempotent replay,
 * and the `writes: "operations"` default (raw `/transact` closed for
 * app-class tokens).
 */

import { beforeAll, describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { EntityId, Operation, Operations } from "../../src/db/Operation.ts";
import { schemaTx } from "../../src/db/ensure.ts";
import { Movie, Movies, User } from "../db/fixture.ts";
import { events } from "../internal/transactor/harness.ts";
import { makePeer, post, type Peer } from "./harness.ts";

const setTitle = Operation(
  "movie/set-title",
  {
    on: Movie,
    input: Schema.Struct({ title: Schema.String }),
    output: Schema.Struct({ title: Schema.String }),
  },
  (op, input) => {
    op.set(op.self, Movie.title, input.title);
    return { title: input.title };
  },
);

let effectRuns = 0;
const ping = Operation(
  "ping",
  {
    input: Schema.Struct({}),
    output: Schema.Struct({ n: Schema.Number }),
  },
  async (op) => {
    const n = await op.effect("count", () => {
      effectRuns += 1;
      return effectRuns;
    });
    return { n };
  },
);

const createNamed = Operation(
  "user/create",
  {
    input: Schema.Struct({ name: Schema.String }),
    output: Schema.Struct({}),
  },
  (op, input) => {
    const e = op.entity();
    e.set(User.name, input.name);
    return {};
  },
);

const setName = Operation(
  "user/set-name",
  {
    on: User,
    input: Schema.Struct({ name: Schema.String }),
    output: Schema.Struct({ name: Schema.String }),
  },
  (op, input) => {
    op.set(op.self, User.name, input.name);
    return { name: input.name };
  },
);

const createCoded = Operation(
  "user/create-coded",
  {
    schema: Movies,
    input: Schema.Struct({ name: Schema.String }),
    output: Schema.Struct({
      id: EntityId,
      code: Schema.NumberFromString,
    }),
  },
  (op, input) => {
    const created = op.put(User, { name: input.name });
    return { id: created, code: 5 };
  },
);

const createByPut = Operation(
  "user/create-put",
  {
    schema: Movies,
    input: Schema.Struct({ name: Schema.String }),
    output: Schema.Struct({}),
  },
  (op, input) => {
    op.put(User, { name: input.name });
    return {};
  },
);

const createShort = Operation(
  "user/create-short",
  {
    schema: Movies,
    input: Schema.Struct({}),
    output: Schema.Struct({}),
  },
  (op) => {
    op.put(User, { age: 1 } as never);
    return {};
  },
);

const updateGhost = Operation(
  "user/update-ghost",
  {
    schema: Movies,
    input: Schema.Struct({}),
    output: Schema.Struct({}),
  },
  (op) => {
    op.update(User, 999_999, { age: 1 });
    return {};
  },
);

const putOnBootstrap = Operation(
  "user/put-bootstrap",
  {
    schema: Movies,
    input: Schema.Struct({}),
    output: Schema.Struct({}),
  },
  (op) => {
    op.put(User, 10, { age: 1 });
    return {};
  },
);

const putOnMovie = Operation(
  "user/put-on-movie",
  {
    schema: Movies,
    input: Schema.Struct({ eid: Schema.Number }),
    output: Schema.Struct({}),
  },
  (op, input) => {
    op.put(User, input.eid, { name: "nope" });
    return {};
  },
);

const putMissingEid = Operation(
  "user/put-missing-eid",
  {
    schema: Movies,
    input: Schema.Struct({}),
    output: Schema.Struct({}),
  },
  (op) => {
    op.put(User, 1008, { name: "squatter" });
    return {};
  },
);

const putDanglingRef = Operation(
  "user/put-dangling-ref",
  {
    schema: Movies,
    input: Schema.Struct({}),
    output: Schema.Struct({}),
  },
  (op) => {
    op.put(User, { name: "Ada", bestFriend: 888888 as never });
    return {};
  },
);

const operations = Operations({
  setTitle,
  ping,
  createNamed,
  setName,
  createCoded,
  createByPut,
  createShort,
  updateGhost,
  putOnBootstrap,
  putOnMovie,
  putMissingEid,
  putDanglingRef,
});

const titles = async (peer: Peer, tok?: string) => {
  const { body } = await peer.json(
    "/db/movies/query",
    post(
      { query: { find: ["?t"], where: [["?e", ":movie/title", "?t"]] } },
      tok,
    ),
  );
  return ((body.result as string[][]) ?? []).map((r) => r[0]).sort();
};

describe("GET /health lists registered operation ids", () => {
  test("the peer reports the registry it was built with", async () => {
    const peer = makePeer("movies", { operations });
    const { status, body } = await peer.json("/health");
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.operations).toEqual([
      "movie/set-title",
      "ping",
      "user/create",
      "user/create-coded",
      "user/create-put",
      "user/create-short",
      "user/put-bootstrap",
      "user/put-dangling-ref",
      "user/put-missing-eid",
      "user/put-on-movie",
      "user/set-name",
      "user/update-ghost",
    ]);
    peer.close();
  });

  test("an empty registry reports an empty list", async () => {
    const peer = makePeer("movies");
    const { body } = await peer.json("/health");
    expect(body.operations).toEqual([]);
    peer.close();
  });
});

describe("POST /db/:name/op", () => {
  test("unknown name is 400, not 409", async () => {
    const peer = makePeer("movies", { operations });
    await peer.seed(schemaTx(Movies) as unknown[]);
    const { status, body } = await peer.json(
      "/db/movies/op",
      post({ name: "nope", input: {} }),
    );
    expect(status).toBe(400);
    expect(String(body.error)).toContain("unknown operation");
    peer.close();
  });

  test("invalid input is 400", async () => {
    const peer = makePeer("movies", { operations });
    await peer.seed(schemaTx(Movies) as unknown[]);
    const { status } = await peer.json(
      "/db/movies/op",
      post({ name: "movie/set-title", entity: 1, input: { title: 9 } }),
    );
    expect(status).toBe(400);
    peer.close();
  });

  test("contextual entity: dangling and foreign-namespace are 409 before effects", async () => {
    const peer = makePeer("movies", { operations });
    await peer.seed(schemaTx(Movies) as unknown[]);
    const seed = await peer.seed([
      { ":db/id": "ada", ":user/name": "Ada" },
      { ":db/id": "heat", ":movie/title": "Heat" },
    ]);
    const ada = seed.tempids.ada!;
    const heat = seed.tempids.heat!;

    const dangling = await peer.json(
      "/db/movies/op",
      post({
        name: "movie/set-title",
        entity: 9_999_999,
        input: { title: "x" },
        clientOpId: "op-dangle",
      }),
    );
    expect(dangling.status).toBe(409);
    expect(dangling.body.tag).toBe("OperationRejected");
    expect(dangling.body.operation).toBe("movie/set-title");
    expect(dangling.body.reason).toBe("dangling");

    const foreign = await peer.json(
      "/db/movies/op",
      post({
        name: "movie/set-title",
        entity: ada,
        input: { title: "x" },
        clientOpId: "op-foreign",
      }),
    );
    expect(foreign.status).toBe(409);
    expect(foreign.body.reason).toBe("foreign");

    const ok = await peer.json(
      "/db/movies/op",
      post({
        name: "movie/set-title",
        entity: heat,
        input: { title: "Heat (1995)" },
        clientOpId: "op-ok",
      }),
    );
    expect(ok.status).toBe(200);
    expect(ok.body.output).toEqual({ title: "Heat (1995)" });
    expect(await titles(peer)).toEqual(["Heat (1995)"]);

    const idsRow = await peer.json(
      "/db/movies/op",
      post({
        name: "movie/set-title",
        entity: { id: ada },
        input: { title: "x" },
        clientOpId: "op-ids-foreign",
      }),
    );
    expect(idsRow.status).toBe(409);
    expect(idsRow.body.reason).toBe("foreign");
    peer.close();
  });

  test("a lookup-shaped entity resolves when the row exists and is dangling when it does not", async () => {
    const peer = makePeer("movies", { operations });
    await peer.seed(schemaTx(Movies) as unknown[]);
    await peer.seed([{ ":user/name": "Ada" }]);

    const missing = await peer.json(
      "/db/movies/op",
      post({
        name: "user/set-name",
        entity: [":user/name", "Missing"],
        input: { name: "Nope" },
        clientOpId: "op-lookup-miss",
      }),
    );
    expect(missing.status).toBe(409);
    expect(missing.body.tag).toBe("OperationRejected");
    expect(missing.body.operation).toBe("user/set-name");
    expect(missing.body.reason).toBe("dangling");

    const ok = await peer.json(
      "/db/movies/op",
      post({
        name: "user/set-name",
        entity: [":user/name", "Ada"],
        input: { name: "Ada Lovelace" },
        clientOpId: "op-lookup-ok",
      }),
    );
    expect(ok.status).toBe(200);
    expect(ok.body.output).toEqual({ name: "Ada Lovelace" });
    const { body } = await peer.json(
      "/db/movies/query",
      post({ query: { find: ["?n"], where: [["?e", ":user/name", "?n"]] } }),
    );
    expect((body.result as string[][]).map((r) => r[0])).toEqual(["Ada Lovelace"]);
    peer.close();
  });

  test("the same clientOpId replays the original ack and does not re-run effects", async () => {
    effectRuns = 0;
    const peer = makePeer("movies", { operations });
    await peer.seed(schemaTx(Movies) as unknown[]);
    const first = await peer.json(
      "/db/movies/op",
      post({ name: "ping", input: {}, clientOpId: "op-ping" }),
    );
    expect(first.status).toBe(200);
    expect(first.body.output).toEqual({ n: 1 });
    expect(effectRuns).toBe(1);
    const t = first.body.t as number;

    const second = await peer.json(
      "/db/movies/op",
      post({ name: "ping", input: {}, clientOpId: "op-ping" }),
    );
    expect(second.status).toBe(200);
    expect(second.body.t).toBe(t);
    expect(second.body.output).toEqual({ n: 1 });
    expect(effectRuns).toBe(1);
    peer.close();
  });

  test("a write op replay keeps t and does not insert a second row", async () => {
    const peer = makePeer("movies", { operations });
    await peer.seed(schemaTx(Movies) as unknown[]);
    const first = await peer.json(
      "/db/movies/op",
      post({
        name: "user/create",
        input: { name: "Ada" },
        clientOpId: "op-ada",
      }),
    );
    expect(first.status).toBe(200);
    const second = await peer.json(
      "/db/movies/op",
      post({
        name: "user/create",
        input: { name: "Ada" },
        clientOpId: "op-ada",
      }),
    );
    expect(second.status).toBe(200);
    expect(second.body.t).toBe(first.body.t);
    const { body } = await peer.json(
      "/db/movies/query",
      post({ query: { find: ["?n"], where: [["?e", ":user/name", "?n"]] } }),
    );
    expect((body.result as string[][]).map((r) => r[0])).toEqual(["Ada"]);
    peer.close();
  });

  test("a clientOpId replay returns the same encoded output as the first commit", async () => {
    const peer = makePeer("movies", { operations });
    await peer.seed(schemaTx(Movies) as unknown[]);
    const first = await peer.json(
      "/db/movies/op",
      post({
        name: "user/create-coded",
        input: { name: "Ada" },
        clientOpId: "op-coded",
      }),
    );
    expect(first.status).toBe(200);
    const firstOut = first.body.output as { id: unknown; code: unknown };
    expect(typeof firstOut.id).toBe("number");
    expect(firstOut.code).toBe("5");
    expect(JSON.stringify(first.body.output)).not.toContain("TxHandle");

    const second = await peer.json(
      "/db/movies/op",
      post({
        name: "user/create-coded",
        input: { name: "Ada" },
        clientOpId: "op-coded",
      }),
    );
    expect(second.status).toBe(200);
    expect(second.body.t).toBe(first.body.t);
    expect(second.body.output).toEqual(first.body.output);
    expect(second.body.tempids).toEqual(first.body.tempids);
    expect(JSON.stringify(second.body.output)).not.toContain("TxHandle");
    peer.close();
  });

  test("put with a unique field unifies a second write onto the same row", async () => {
    const peer = makePeer("movies", { operations });
    await peer.seed(schemaTx(Movies) as unknown[]);
    const created = await peer.json(
      "/db/movies/op",
      post({
        name: "user/create-put",
        input: { name: "Ada" },
        clientOpId: "op-put",
      }),
    );
    expect(created.status).toBe(200);
    const again = await peer.json(
      "/db/movies/op",
      post({
        name: "user/create-put",
        input: { name: "Ada" },
        clientOpId: "op-put-again",
      }),
    );
    expect(again.status).toBe(200);
    const { body } = await peer.json(
      "/db/movies/query",
      post({ query: { find: ["?e"], where: [["?e", ":user/name", "Ada"]] } }),
    );
    expect((body.result as unknown[][]).length).toBe(1);
    peer.close();
  });

});

describe('writes: "operations" is the peer default', () => {
  const ISS = "https://auth.acme.test";
  const AUD = "ramose:peer:test";
  let sign: (
    claims: Record<string, unknown>,
    over?: Record<string, unknown>,
  ) => Promise<string>;
  let JWKS: string;

  beforeAll(async () => {
    const { privateKey, publicKey } = await generateKeyPair("ES256", {
      extractable: true,
    });
    JWKS = JSON.stringify({
      keys: [{ ...(await exportJWK(publicKey)), alg: "ES256", kid: "test" }],
    });
    sign = async (claims, over = {}) => {
      let jwt = new SignJWT(claims).setProtectedHeader({
        alg: "ES256",
        kid: "test",
      });
      jwt = jwt
        .setIssuer((over.iss as string) ?? ISS)
        .setAudience((over.aud as string) ?? AUD);
      jwt = jwt
        .setSubject((over.sub as string) ?? "user_ada")
        .setIssuedAt((over.iat as number) ?? undefined)
        .setExpirationTime((over.exp as string | number) ?? "5m");
      return jwt.sign(privateKey);
    };
  });

  const token = (db: string, cls: string, sub = "user_ada") =>
    sign({ ramose: { db, class: cls } }, { sub });

  const allow = (expr: unknown) => [{ _tag: "allow", expr }];
  const POLICY = {
    version: 1,
    principal: ":user/name",
    classes: ["member", "admin"],
    ns: {
      user: {
        read: allow({ _tag: "class", class: "member" }),
        create: allow({ _tag: "class", class: "member" }),
        add: allow({ _tag: "class", class: "member" }),
      },
      movie: {
        read: allow({ _tag: "class", class: "member" }),
        create: allow({ _tag: "class", class: "member" }),
        add: allow({ _tag: "class", class: "member" }),
      },
    },
  };

  const envOf = () => ({
    RAMOSE_POLICY: JSON.stringify(POLICY),
    RAMOSE_JWKS_JSON: JWKS,
    RAMOSE_JWT_ISS: ISS,
    RAMOSE_JWT_AUD: AUD,
  });

  test("no writes / no RAMOSE_WRITES: app-class token is denied on /transact; /op works; admin and the seed token keep /transact", async () => {
    const peer = makePeer("movies", {
      operations,
      env: envOf(),
    });
    await peer.seed(schemaTx(Movies) as unknown[]);
    await peer.seed([{ ":user/name": "user_ada" }]);
    const member = await token("movies", "member");
    const admin = await token("movies", "admin");

    const denied = await peer.json(
      "/db/movies/transact",
      post({ tx: [{ ":movie/title": "raw" }] }, member),
    );
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe("operations");

    const asAdmin = await peer.json(
      "/db/movies/transact",
      post({ tx: [{ ":movie/title": "admin-write" }] }, admin),
    );
    expect(asAdmin.status).toBe(200);

    const viaOp = await peer.json(
      "/db/movies/op",
      post({ name: "user/create", input: { name: "Bea" }, clientOpId: "op-bea" }, member),
    );
    expect(viaOp.status).toBe(200);

    // `$token` is not admin and is not an app class — seed/install still
    // reaches /transact (ensure of an already-deployed catalog is a no-op).
    const seeded = makePeer("movies", {
      operations,
      env: { ...envOf(), RAMOSE_TOKEN: "s3cret" },
    });
    await seeded.seed(schemaTx(Movies) as unknown[]);
    const asSeed = await seeded.json(
      "/db/movies/transact",
      post({ tx: schemaTx(Movies) }, "s3cret"),
    );
    expect(asSeed.status).toBe(200);
    expect(asSeed.body.code).not.toBe("operations");
    peer.close();
    seeded.close();
  });

  test('writes: "all" or RAMOSE_WRITES=all restores raw /transact for app tokens', async () => {
    const member = await token("movies", "member");
    for (const options of [
      { operations, writes: "all" as const, env: envOf() },
      { operations, env: { ...envOf(), RAMOSE_WRITES: "all" } },
    ]) {
      const peer = makePeer("movies", options);
      await peer.seed(schemaTx(Movies) as unknown[]);
      await peer.seed([{ ":user/name": "user_ada" }]);
      const raw = await peer.json(
        "/db/movies/transact",
        post({ tx: [{ ":movie/title": "raw-ok" }] }, member),
      );
      expect(raw.status).toBe(200);
      peer.close();
    }
  });

  test("policy + writes: all emits writes.all-with-policy once, and does not fail the request", async () => {
    const from = events.length;
    const peer = makePeer("movies", {
      operations,
      env: { ...envOf(), RAMOSE_WRITES: "all" },
    });
    await peer.seed(schemaTx(Movies) as unknown[]);
    const member = await token("movies", "member");
    const first = await peer.json(
      "/db/movies/transact",
      post({ tx: [{ ":movie/title": "open" }] }, member),
    );
    expect(first.status).toBe(200);
    const warned = events.slice(from).filter((e) => e.event === "writes.all-with-policy");
    expect(warned).toHaveLength(1);
    expect(warned[0]?.level).toBe("warn");
    expect(String(warned[0]?.message)).toMatch(/raw \/transact stays open/);
    const second = await peer.json(
      "/db/movies/query",
      post({ query: { find: ["?t"], where: [["?e", ":movie/title", "?t"]] } }, member),
    );
    expect(second.status).toBe(200);
    expect(events.slice(from).filter((e) => e.event === "writes.all-with-policy")).toHaveLength(1);
    peer.close();
  });

  test("unrecognized RAMOSE_WRITES warns and fails closed to operations", async () => {
    const from = events.length;
    const peer = makePeer("movies", {
      operations,
      env: { ...envOf(), RAMOSE_WRITES: "All" },
    });
    await peer.seed(schemaTx(Movies) as unknown[]);
    const member = await token("movies", "member");
    const denied = await peer.json(
      "/db/movies/transact",
      post({ tx: [{ ":movie/title": "typo-opt-out" }] }, member),
    );
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe("operations");
    const warned = events.slice(from).filter((e) => e.event === "writes.unrecognized");
    expect(warned).toHaveLength(1);
    expect(warned[0]?.level).toBe("warn");
    expect(String(warned[0]?.message)).toMatch(/not "all" or "operations"/);
    peer.close();
  });

  test("put missing a required field is 409 TxRejected tx/required", async () => {
    const peer = makePeer("movies", { operations });
    await peer.seed(schemaTx(Movies) as unknown[]);
    const { status, body } = await peer.json(
      "/db/movies/op",
      post({ name: "user/create-short", input: {}, clientOpId: "op-short" }),
    );
    expect(status).toBe(409);
    expect(body.tag).toBe("TxRejected");
    expect(body.code).toBe("tx/required");
    peer.close();
  });

  test("update of a missing row is 409 TxRejected tx/missing-entity", async () => {
    const peer = makePeer("movies", { operations });
    await peer.seed(schemaTx(Movies) as unknown[]);
    const { status, body } = await peer.json(
      "/db/movies/op",
      post({ name: "user/update-ghost", input: {}, clientOpId: "op-ghost" }),
    );
    expect(status).toBe(409);
    expect(body.tag).toBe("TxRejected");
    expect(body.code).toBe("tx/missing-entity");
    peer.close();
  });

  test("H1 put on bootstrap eid is 409 TxRejected tx/required", async () => {
    const peer = makePeer("movies", { operations });
    await peer.seed(schemaTx(Movies) as unknown[]);
    const { status, body } = await peer.json(
      "/db/movies/op",
      post({ name: "user/put-bootstrap", input: {}, clientOpId: "op-h1" }),
    );
    expect(status).toBe(409);
    expect(body.tag).toBe("TxRejected");
    expect(body.code).toBe("tx/required");
    peer.close();
  });

  test("H2 put onto another namespace is 409 TxRejected tx/wrong-entity", async () => {
    const peer = makePeer("movies", { operations });
    await peer.seed(schemaTx(Movies) as unknown[]);
    const seeded = await peer.seed([{ ":db/id": "heat", ":movie/title": "Heat" }]);
    const filmEid = seeded.tempids.heat!;
    const { status, body } = await peer.json(
      "/db/movies/op",
      post({
        name: "user/put-on-movie",
        input: { eid: filmEid },
        clientOpId: "op-h2",
      }),
    );
    expect(status).toBe(409);
    expect(body.tag).toBe("TxRejected");
    expect(body.code).toBe("tx/wrong-entity");
    peer.close();
  });

  test("H3 put at a nonexistent eid is 409 TxRejected tx/missing-entity", async () => {
    const peer = makePeer("movies", { operations });
    await peer.seed(schemaTx(Movies) as unknown[]);
    const { status, body } = await peer.json(
      "/db/movies/op",
      post({ name: "user/put-missing-eid", input: {}, clientOpId: "op-h3" }),
    );
    expect(status).toBe(409);
    expect(body.tag).toBe("TxRejected");
    expect(body.code).toBe("tx/missing-entity");
    peer.close();
  });

  test("H4 dangling ref is 409 TxRejected tx/missing-entity", async () => {
    const peer = makePeer("movies", { operations });
    await peer.seed(schemaTx(Movies) as unknown[]);
    const { status, body } = await peer.json(
      "/db/movies/op",
      post({ name: "user/put-dangling-ref", input: {}, clientOpId: "op-h4" }),
    );
    expect(status).toBe(409);
    expect(body.tag).toBe("TxRejected");
    expect(body.code).toBe("tx/missing-entity");
    peer.close();
  });
});
