/**
 * The installed client catalog (#477 slice 1).
 *
 * The claim that matters here is agreement: the hash a browser sends on every
 * activation has to be the one the server derives from the deployed unit, or
 * every activation terminates `update-required` and no cache is ever reusable.
 * So both sides are computed here from the same authored definition and
 * compared — the server's through the real deployment assembly.
 */

import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { Catalog } from "../../src/Catalog.ts";
import {
  Entity,
  Field,
  Ref,
  Schema,
  Trait,
  string,
  timestamp,
  type AnySchema,
} from "../../src/db/internal.ts";
import {
  DigestHex,
  assembleCatalogDefinitions,
  compileReadAuthorization,
  hashReadCompatibility,
} from "../../src/internal/authorization/index.ts";
import { installClientCatalog } from "../../src/client/catalog.ts";

const Timestamped = Trait("timestamped", { createdAt: timestamp() });

const Owner = Entity("owner", {
  sub: Field.unique(string(), "strict"),
});

const Note = Entity("note", {
  title: string(),
  body: string({ optional: true }),
  owner: Ref(Owner),
  parent: Field(Ref.self, { optional: true }),
}, { traits: [Timestamped] });

const Notes = Schema({ owner: Owner, note: Note });

const catalogFor = async (schema: AnySchema, key = "client-notes") =>
  Catalog(key, {
    schema,
    policy: await Effect.runPromise(compileReadAuthorization({ schema, rules: [] })),
  });

/** The hash the deployed unit carries, through the real assembly path. */
const deployedHash = async (definition: Awaited<ReturnType<typeof catalogFor>>) => {
  const definitions = await Effect.runPromise(assembleCatalogDefinitions({
    root: definition,
    artifactHash: DigestHex.make("0".repeat(64)),
  }));
  const unit = Result.getOrThrow(definitions.require(definitions.root));
  return Effect.runPromise(hashReadCompatibility(unit.unit.catalog));
};

describe("installClientCatalog", () => {
  test("derives the hash the deployed catalog unit carries", async () => {
    const definition = await catalogFor(Notes);
    const installed = await installClientCatalog(definition);

    expect(installed.readCompatibilityHash).toBe(await deployedHash(definition));
    // Full untruncated SHA-256 as unpadded base64url.
    expect(installed.readCompatibilityHash).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("is stable across the catalog key and the policy", async () => {
    const renamed = await catalogFor(Notes, "another-key");
    const restricted = Catalog("client-notes", {
      schema: Notes,
      policy: await Effect.runPromise(compileReadAuthorization({
        schema: Notes,
        rules: [],
        classes: ["member"],
      })),
    });

    const base = await installClientCatalog(await catalogFor(Notes));
    expect((await installClientCatalog(renamed)).readCompatibilityHash)
      .toBe(base.readCompatibilityHash);
    expect((await installClientCatalog(restricted)).readCompatibilityHash)
      .toBe(base.readCompatibilityHash);
  });

  test("rotates when a stored field changes", async () => {
    const Widened = Schema({
      owner: Owner,
      note: Entity("note", {
        title: string(),
        body: string({ optional: true }),
        owner: Ref(Owner),
        parent: Field(Ref.self, { optional: true }),
        rank: string(),
      }, { traits: [Timestamped] }),
    });

    const base = await installClientCatalog(await catalogFor(Notes));
    const widened = await installClientCatalog(await catalogFor(Widened));
    expect(widened.readCompatibilityHash).not.toBe(base.readCompatibilityHash);
    expect(widened.readCompatibilityHash).toBe(await deployedHash(await catalogFor(Widened)));
  });

  test("lowers the authored schema to the local index attributes", async () => {
    const installed = await installClientCatalog(await catalogFor(Notes));
    const byIdent = new Map(installed.attributes.map((spec) => [spec.ident, spec]));

    expect(byIdent.get(":owner/sub")).toEqual({
      ident: ":owner/sub",
      valueType: ":db.type/string",
      cardinality: "one",
      unique: "value",
      index: true,
      isComponent: false,
      optional: false,
    });
    expect(byIdent.get(":note/owner")?.valueType).toBe(":db.type/ref");
    expect(byIdent.get(":note/body")?.optional).toBe(true);
    // Composed trait fields are the entity's own local attributes.
    expect(byIdent.get(":timestamped/createdAt")?.valueType).toBe(":db.type/instant");
    // Documentation is not part of a replica, and no spec may carry one.
    expect(installed.attributes.some((spec) => "doc" in spec)).toBe(false);
  });

  test("binds the deployed trait composition and installs no projection", async () => {
    const installed = await installClientCatalog(await catalogFor(Notes));

    expect(installed.composition.isEntityIdent(":note")).toBe(true);
    expect(installed.composition.transitiveTraits(":note")).toContain(":timestamped");
    expect(installed.projections.entries.size).toBe(0);
    expect(installed.projections.build).toContain(installed.readCompatibilityHash);
  });
});
