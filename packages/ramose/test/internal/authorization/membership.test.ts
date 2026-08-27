/**
 * Canonical membership: closure derivation, comparison, and fail-closed
 * decisions. No field-prefix inference (ID-1–ID-5).
 */
import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import {
  CatalogId,
  CatalogVersion,
  DatabaseId,
  EntityId,
  SchemaFingerprint,
  TraitId,
} from "../../../src/internal/authorization/identities.ts";
import {
  decideMembership,
  deriveCanonicalMembership,
  deriveLocalMembership,
  fieldAllowedOn,
  fieldOwnerIdent,
  fromCanonicalMembership,
  membershipEqual,
  membershipFailureOf,
  occupiedCompositionFailure,
  toCanonicalMembership,
  type MembershipCatalogView,
} from "../../../src/internal/authorization/membership.ts";
import {
  denyMembershipFailure,
  applyMembershipWrite,
  membershipCatalogLayer,
  memoryMembershipTransactorLayer,
} from "../../../src/internal/authorization/runtime/membership.ts";
import { AuthorizationDenied } from "../../../src/internal/authorization/failures.ts";
import { prepareAuthorizationCatalog } from "../../../src/internal/authorization/validation/catalog.ts";
import type { CatalogDescriptor } from "../../../src/internal/authorization/catalog.ts";

const catalogView = (spec: {
  readonly entities: readonly string[];
  readonly traits?: Readonly<Record<string, readonly string[]>>;
}): MembershipCatalogView => {
  const traitEdges = spec.traits ?? {};
  const close = (ident: string): string[] => {
    const out = new Set<string>();
    const stack = [...(traitEdges[ident] ?? [])];
    while (stack.length > 0) {
      const next = stack.pop()!;
      if (out.has(next)) continue;
      out.add(next);
      for (const inner of traitEdges[next] ?? []) stack.push(inner);
    }
    return [...out].sort();
  };
  return {
    isEntityIdent: (ident) => spec.entities.includes(ident),
    isTraitIdent: (ident) => ident in traitEdges || Object.values(traitEdges).some((ts) => ts.includes(ident)),
    transitiveTraits: close,
    composesOf: (ident) => traitEdges[ident] ?? [],
  };
};

const Board = catalogView({
  entities: [":issue", ":note", ":diamond"],
  traits: {
    ":issue": [":taggable"],
    ":note": [":soft"],
    ":diamond": [":taggable", ":annotated"],
    ":annotated": [":taggable", ":timestamped"],
  },
});

describe("field owner addressing", () => {
  test("reads the field ident, not the entity's identity", () => {
    expect(fieldOwnerIdent(":issue/title")).toBe(":issue");
    expect(fieldOwnerIdent(":taggable/tag")).toBe(":taggable");
    expect(fieldOwnerIdent(":issue")).toBe(":issue");
    expect(fieldOwnerIdent(":ramose/type")).toBeUndefined();
    expect(fieldOwnerIdent(":db/ident")).toBeUndefined();
  });
});

describe("closure derivation", () => {
  test("materializes direct and transitive traits, diamonds collapsed", () => {
    const diamond = deriveLocalMembership(Board, ":diamond");
    expect(Result.isSuccess(diamond)).toBe(true);
    if (Result.isFailure(diamond)) return;
    expect(diamond.success).toEqual({
      type: ":diamond",
      traits: [":annotated", ":taggable", ":timestamped"],
    });
    expect(fieldAllowedOn(Board, ":diamond", ":taggable/tag")).toBe(true);
    expect(fieldAllowedOn(Board, ":diamond", ":soft/note")).toBe(false);
  });

  test("unknown type is stale", () => {
    const missing = deriveLocalMembership(Board, ":task");
    expect(Result.isFailure(missing)).toBe(true);
    if (Result.isSuccess(missing)) return;
    expect(missing.failure._tag).toBe("MembershipStale");
  });
});

describe("decideMembership", () => {
  test("create requires a declared catalog type", () => {
    expect(
      decideMembership(Board, {
        observed: { types: [], traits: [] },
        existingType: undefined,
        isCreate: true,
        clientWroteType: false,
        clientWroteTraits: false,
      })._tag,
    ).toBe("missing");
  });

  test("client trait writes are forged", () => {
    expect(
      decideMembership(Board, {
        observed: { types: [":issue"], traits: [":taggable"] },
        existingType: undefined,
        isCreate: true,
        clientWroteType: true,
        clientWroteTraits: true,
      })._tag,
    ).toBe("forged");
  });

  test("two types are contradictory", () => {
    expect(
      decideMembership(Board, {
        observed: { types: [":issue", ":note"], traits: [] },
        existingType: undefined,
        isCreate: true,
        clientWroteType: true,
        clientWroteTraits: false,
      })._tag,
    ).toBe("contradictory");
  });

  test("mutating type on update is forged", () => {
    expect(
      decideMembership(Board, {
        observed: { types: [":note"], traits: [":soft"] },
        existingType: ":issue",
        isCreate: false,
        clientWroteType: true,
        clientWroteTraits: false,
      })._tag,
    ).toBe("forged");
  });

  test("stale type is rejected", () => {
    const decision = decideMembership(Board, {
      observed: { types: [":ghost"], traits: [] },
      existingType: undefined,
      isCreate: true,
      clientWroteType: true,
      clientWroteTraits: false,
    });
    expect(decision._tag).toBe("stale");
  });

  test("update with stored stamps matching the catalog is ok", () => {
    expect(
      decideMembership(Board, {
        observed: { types: [":issue"], traits: [":taggable"] },
        existingType: ":issue",
        isCreate: false,
        clientWroteType: false,
        clientWroteTraits: false,
      }),
    ).toEqual({
      _tag: "ok",
      expected: { type: ":issue", traits: [":taggable"] },
    });
  });

  test("create with a declared type yields the catalog closure", () => {
    const decision = decideMembership(Board, {
      observed: { types: [":diamond"], traits: [] },
      existingType: undefined,
      isCreate: true,
      clientWroteType: true,
      clientWroteTraits: false,
    });
    expect(decision).toEqual({
      _tag: "ok",
      expected: {
        type: ":diamond",
        traits: [":annotated", ":taggable", ":timestamped"],
      },
    });
  });
});

describe("canonical identities", () => {
  test("round-trip local stamps through catalog-scoped ids", () => {
    const catalog = CatalogId.make("app");
    const local = {
      type: ":issue",
      traits: [":taggable"],
    };
    const canonical = toCanonicalMembership(catalog, local);
    expect(canonical.type).toEqual(EntityId.make({ catalog, name: "issue" }));
    expect(canonical.traits).toEqual([TraitId.make({ catalog, name: "taggable" })]);
    expect(membershipEqual(fromCanonicalMembership(canonical), local)).toBe(true);
  });

  test("prepared catalog closure matches stored stamps", () => {
    const catalog = CatalogId.make("app");
    const issue = EntityId.make({ catalog, name: "issue" });
    const taggable = TraitId.make({ catalog, name: "taggable" });
    const descriptor: CatalogDescriptor = {
      id: catalog,
      database: DatabaseId.make("db"),
      version: CatalogVersion.make("1"),
      fingerprint: SchemaFingerprint.make("fp"),
      entities: [{ id: issue, traits: [taggable] }],
      traits: [{ id: taggable, traits: [] }],
      fields: [],
      operations: [],
      traitComposition: [{ composer: issue, trait: taggable, transitive: [taggable] }],
    };
    const prepared = prepareAuthorizationCatalog(
      {
        catalog,
        database: descriptor.database,
        catalogVersion: descriptor.version,
        schemaFingerprint: descriptor.fingerprint,
      },
      descriptor,
    );
    expect(Result.isSuccess(prepared)).toBe(true);
    if (Result.isFailure(prepared)) return;
    const membership = deriveCanonicalMembership(prepared.success, issue);
    expect(Result.isSuccess(membership)).toBe(true);
    if (Result.isFailure(membership)) return;
    expect(fromCanonicalMembership(membership.success)).toEqual({
      type: ":issue",
      traits: [":taggable"],
    });
  });
});

describe("occupied composition", () => {
  test("is a distinct tagged failure", () => {
    const failure = occupiedCompositionFailure(":issue", [":taggable"], [":taggable", ":soft"]);
    expect(failure._tag).toBe("OccupiedCompositionChange");
    expect(failure.type).toBe(":issue");
  });
});

describe("Effect orchestration", () => {
  test("injected catalog and transactor apply one membership value", async () => {
    const applied = new Map();
    const program = applyMembershipWrite(1001, {
      observed: { types: [":issue"], traits: [] },
      existingType: undefined,
      isCreate: true,
      clientWroteType: true,
      clientWroteTraits: false,
    }).pipe(
      Effect.provide(membershipCatalogLayer(Board)),
      Effect.provide(memoryMembershipTransactorLayer({ applied })),
    );
    const membership = await Effect.runPromise(program);
    expect(membership.traits).toEqual([":taggable"]);
    expect(applied.get(1001)).toEqual(membership);
  });

  test("inner membership failures collapse at the security boundary", async () => {
    const failure = membershipFailureOf({ _tag: "forged" }, 1);
    const denied = await Effect.runPromise(Effect.flip(denyMembershipFailure(failure)));
    expect(denied).toBeInstanceOf(AuthorizationDenied);
  });
});
