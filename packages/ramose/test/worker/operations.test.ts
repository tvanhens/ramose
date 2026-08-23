/**
 * Peer `/op`: resolve, decode, contextual entity checks, idempotent replay,
 * and `writes: "operations"` enforcement.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { Operation, Operations } from "../../src/db/Operation.ts";
import { schemaTx } from "../../src/db/ensure.ts";
import { Movie, Movies, User } from "../db/fixture.ts";
import { makePeer, post, type Peer } from "./harness.ts";

const setTitle = Operation(
  "movie/set-title",
  {
    on: Movie,
    input: Schema.Struct({ title: Schema.String }),
    output: Schema.Struct({ title: Schema.String }),
  },
  (op, input) => {
    op.add(op.self, Movie.title, input.title);
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
    e.add(User.name, input.name);
    return {};
  },
);

const operations = Operations({ setTitle, ping, createNamed });

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

});

describe('writes: "operations"', () => {
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

  test("an app-class token cannot POST /transact; admin still can; /op stays open", async () => {
    const peer = makePeer("movies", {
      operations,
      writes: "operations",
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
    peer.close();
  });
});
