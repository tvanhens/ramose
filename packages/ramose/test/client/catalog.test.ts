import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import {
  Entity,
  Field,
  Ref,
  Schema,
  Trait,
  string,
  timestamp,
  type AnySchemaDefinition,
} from "../../src/db/internal.ts";
import {
  DigestHex,
  assembleCatalogDefinitions,
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

const notesSchema = (key: string) => {
  const schema = Schema(key, { owner: Owner, note: Note });
  schema.applyPolicy(() => {});
  return schema;
};

const Notes = notesSchema("client-notes");

const deployedHash = async (definition: AnySchemaDefinition) => {
  const definitions = await Effect.runPromise(assembleCatalogDefinitions({
    root: definition,
    artifactHash: DigestHex.make("0".repeat(64)),
  }));
  const unit = Result.getOrThrow(definitions.require(definitions.root));
  return Effect.runPromise(hashReadCompatibility(unit.unit.catalog));
};

describe("installClientCatalog", () => {
  test("derives the hash the deployed catalog unit carries", async () => {
    const installed = await installClientCatalog(Notes);

    expect(installed.readCompatibilityHash).toBe(await deployedHash(Notes));

    expect(installed.readCompatibilityHash).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("is stable across the catalog key and the policy", async () => {
    const renamed = notesSchema("another-key");
    const restricted = Schema("client-notes", { owner: Owner, note: Note });
    restricted.applyPolicy({
      roles: ["member"],
    }, () => {
    });

    const base = await installClientCatalog(Notes);
    expect((await installClientCatalog(renamed)).readCompatibilityHash)
      .toBe(base.readCompatibilityHash);
    expect((await installClientCatalog(restricted)).readCompatibilityHash)
      .toBe(base.readCompatibilityHash);
  });

  test("rotates when a stored field changes", async () => {
    const Widened = Schema("client-notes-widened", {
      owner: Owner,
      note: Entity("note", {
        title: string(),
        body: string({ optional: true }),
        owner: Ref(Owner),
        parent: Field(Ref.self, { optional: true }),
        rank: string(),
      }, { traits: [Timestamped] }),
    });
    Widened.applyPolicy(() => {});

    const base = await installClientCatalog(Notes);
    const widened = await installClientCatalog(Widened);
    expect(widened.readCompatibilityHash).not.toBe(base.readCompatibilityHash);
    expect(widened.readCompatibilityHash).toBe(await deployedHash(Widened));
  });

  test("lowers the authored schema to the local index attributes", async () => {
    const installed = await installClientCatalog(Notes);
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

    expect(byIdent.get(":timestamped/createdAt")?.valueType).toBe(":db.type/instant");

    expect(installed.attributes.some((spec) => "doc" in spec)).toBe(false);
  });

  test("binds the deployed trait composition and installs no projection", async () => {
    const installed = await installClientCatalog(Notes);

    expect(installed.composition.isEntityIdent(":note")).toBe(true);
    expect(installed.composition.transitiveTraits(":note")).toContain(":timestamped");
    expect(installed.projections.entries.size).toBe(0);
    expect(installed.projections.build).toContain(installed.readCompatibilityHash);
  });
});
