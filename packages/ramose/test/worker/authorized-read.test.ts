/**
 * HTTP parse for one-shot reads — catalog proof, view, and read shape.
 * No Durable Objects; Request objects only.
 */

import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { CatalogId, CatalogUnitHash } from "../../src/internal/authorization/index.ts";
import { parseOneShotReadRequest } from "../../src/worker/authorized-read.ts";
import { digestHex } from "../internal/authorization/fixtures.ts";

const catalog = CatalogId.make("app");
const unitHash = CatalogUnitHash.make(digestHex(0xab));

const runParse = (request: Request, rest: string) =>
  Effect.runPromise(parseOneShotReadRequest(request, rest));

const runParseFail = (request: Request, rest: string) =>
  Effect.runPromise(Effect.flip(parseOneShotReadRequest(request, rest)));

describe("parseOneShotReadRequest", () => {
  test("POST /query reads catalog proof and the query body", async () => {
    const parsed = await runParse(
      new Request("https://peer.test/db/todos/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          catalog,
          unitHash,
          query: { find: ["?t"], where: [["?e", ":issue/title", "?t"]] },
          inputs: [1],
          asOf: 9,
          history: true,
        }),
      }),
      "/query",
    );
    expect(parsed.catalogKey).toBe(catalog);
    expect(parsed.unitHash).toBe(unitHash);
    expect(parsed.view).toEqual({ asOf: 9, history: true });
    expect(parsed.read).toEqual({
      kind: "query",
      query: { find: ["?t"], where: [["?e", ":issue/title", "?t"]] },
      inputs: [1],
    });
  });

  test("GET /entity takes catalog proof from headers", async () => {
    const parsed = await runParse(
      new Request("https://peer.test/db/todos/entity/42?asOf=3", {
        method: "GET",
        headers: {
          "x-ramose-catalog": catalog,
          "x-ramose-unit-hash": unitHash,
        },
      }),
      "/entity/42",
    );
    expect(parsed.read).toEqual({ kind: "entity", ref: 42 });
    expect(parsed.view).toEqual({ asOf: 3 });
    expect(parsed.catalogKey).toBe(catalog);
  });

  test("POST /pull and lookup shapes", async () => {
    const pull = await runParse(
      new Request("https://peer.test/db/todos/pull", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ catalog, unitHash, eid: 7, pattern: ["*"] }),
      }),
      "/pull",
    );
    expect(pull.read).toEqual({ kind: "pull", eid: 7, pattern: ["*"] });

    const lookup = await runParse(
      new Request("https://peer.test/db/todos/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ catalog, unitHash, lookup: [":issue/title", "Bug"] }),
      }),
      "/query",
    );
    expect(lookup.read).toEqual({ kind: "lookup", ref: [":issue/title", "Bug"] });
  });

  test("missing catalog proof is Unauthorized", async () => {
    const error = await runParseFail(
      new Request("https://peer.test/db/todos/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: { find: ["?e"], where: [] } }),
      }),
      "/query",
    );
    expect(error._tag).toBe("Unauthorized");
  });

  test("malformed query body is BadRequest after proof", async () => {
    const error = await runParseFail(
      new Request("https://peer.test/db/todos/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ catalog, unitHash }),
      }),
      "/query",
    );
    expect(error._tag).toBe("BadRequest");
  });
});
