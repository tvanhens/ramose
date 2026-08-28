/**
 * HTTP parse for catalog-bound writes — catalog proof and operation shape.
 * No Durable Objects; Request objects only.
 */

import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { CatalogId, CatalogUnitHash } from "../../src/internal/authorization/index.ts";
import { parseOperationRequest } from "../../src/worker/authorized-write.ts";
import { Unauthorized } from "../../src/worker/errors.ts";
import { digestHex } from "../internal/authorization/fixtures.ts";

const catalog = CatalogId.make("app");
const unitHash = CatalogUnitHash.make(digestHex(0xab));

const runParse = (request: Request, rest = "/op") =>
  Effect.runPromise(parseOperationRequest(request, rest));

const runParseFail = (request: Request, rest = "/op") =>
  Effect.runPromise(Effect.flip(parseOperationRequest(request, rest)));

describe("parseOperationRequest", () => {
  test("POST /op reads catalog proof, operation identity, entity, and input", async () => {
    const parsed = await runParse(
      new Request("https://peer.test/db/todos/op", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          catalog,
          unitHash,
          operation: {
            owner: { kind: "entity", name: "issue" },
            localName: "rename",
            target: "required",
          },
          entity: 42,
          input: { title: "Fixed" },
        }),
      }),
    );
    expect(parsed.catalogKey).toBe(catalog);
    expect(parsed.unitHash).toBe(unitHash);
    expect(parsed.invocation).toEqual({
      owner: { kind: "entity", name: "issue" },
      localName: "rename",
      target: "required",
      entity: 42,
      input: { title: "Fixed" },
    });
  });

  test("static operations omit entity and default input to {}", async () => {
    const parsed = await runParse(
      new Request("https://peer.test/db/todos/op", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-ramose-catalog": catalog,
          "x-ramose-unit-hash": unitHash,
        },
        body: JSON.stringify({
          operation: {
            owner: { kind: "entity", name: "issue" },
            localName: "create",
            target: "none",
          },
        }),
      }),
    );
    expect(parsed.invocation.entity).toBeUndefined();
    expect(parsed.invocation.input).toEqual({});
    expect(parsed.invocation.target).toBe("none");
  });

  test("malformed operation shape is BadRequest; missing proof is Unauthorized", async () => {
    const bad = await runParseFail(
      new Request("https://peer.test/db/todos/op", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ catalog, unitHash, operation: { localName: "rename" } }),
      }),
    );
    expect(bad._tag).toBe("BadRequest");

    const denied = await runParseFail(
      new Request("https://peer.test/db/todos/op", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operation: { owner: { kind: "entity", name: "issue" }, localName: "rename", target: "required" },
        }),
      }),
    );
    expect(denied).toBeInstanceOf(Unauthorized);

    const other = await runParseFail(
      new Request("https://peer.test/db/todos/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ catalog, unitHash }),
      }),
      "/query",
    );
    expect(other).toBeInstanceOf(Unauthorized);
  });
});
