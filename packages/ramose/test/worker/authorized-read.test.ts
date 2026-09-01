import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { CatalogId, CatalogUnitHash } from "../../src/internal/authorization/index.ts";
import { stringifyJson } from "../../src/internal/core/json.ts";
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

  test("POST /live uses the same query body as one-shot", async () => {
    const parsed = await runParse(
      new Request("https://peer.test/db/todos/live", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          catalog,
          unitHash,
          query: { find: ["?t"], where: [["?e", ":issue/title", "?t"]] },
        }),
      }),
      "/live",
    );
    expect(parsed.read).toEqual({
      kind: "query",
      query: { find: ["?t"], where: [["?e", ":issue/title", "?t"]] },
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

  test("rejects database selectors", async () => {
    const bodyPath = runParse(
      new Request("https://peer.test/db/root/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          at: ["acme", "design"],
          query: { find: ["?e"], where: [["?e", ":pathNote/text", "?text"]] },
        }),
      }),
      "/query",
    );
    await expect(bodyPath).rejects.toThrow("database selector 'at' is not supported");

    const queryPath = runParse(
      new Request("https://peer.test/db/root/entity/42?at=acme&at=design"),
      "/entity/42",
    );
    await expect(queryPath).rejects.toThrow("database selector 'at' is not supported");
  });

  test("query inputs, lookup values, and pull refs decode $inst / $bytes / $uuid", async () => {
    const at = new Date(1_700_000_000_000);
    const blob = new Uint8Array([1, 2, 3]);
    const uuid = "550e8400-e29b-41d4-a716-446655440000";

    const query = await runParse(
      new Request("https://peer.test/db/todos/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: stringifyJson({
          catalog,
          unitHash,
          query: { find: ["?e"], where: [["?e", ":issue/at", at]] },
          inputs: [at, blob, { $uuid: "550E8400-E29B-41D4-A716-446655440000" }],
        }),
      }),
      "/query",
    );
    expect(query.read.kind).toBe("query");
    if (query.read.kind === "query") {
      const where = (query.read.query as { where: unknown[][] }).where[0]![2];
      expect(where).toEqual(at);
      expect(query.read.inputs).toEqual([at, blob, uuid]);
    }

    const lookup = await runParse(
      new Request("https://peer.test/db/todos/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: stringifyJson({ catalog, unitHash, lookup: [":issue/blob", blob] }),
      }),
      "/query",
    );
    expect(lookup.read).toEqual({ kind: "lookup", ref: [":issue/blob", blob] });

    const pull = await runParse(
      new Request("https://peer.test/db/todos/pull", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: stringifyJson({
          catalog,
          unitHash,
          eid: [":issue/id", { $uuid: "550E8400-E29B-41D4-A716-446655440000" }],
          pattern: ["*"],
        }),
      }),
      "/pull",
    );
    expect(pull.read).toEqual({ kind: "pull", eid: [":issue/id", uuid], pattern: ["*"] });
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
