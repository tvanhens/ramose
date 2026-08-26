import { describe, expect, test } from "bun:test";
import { canonicalJson } from "../../src/internal/authorization/canonical.ts";
import { POLICY_TEMPLATE_VERSION } from "../../src/internal/authorization/bounds.ts";
import { isPolicyTemplateIR } from "../../src/internal/authorization/template.ts";
import { isSealedInstalled } from "../../src/internal/authorization/installed.ts";
import {
  catalog,
  compileTaggablePolicy,
  installTaggablePolicy,
} from "./fixtures.ts";

describe("Taggable policy compilation", () => {
  test("compiles a complete Taggable → Tag → TagGrant policy", () => {
    const template = compileTaggablePolicy();
    expect(isPolicyTemplateIR(template)).toBe(true);
    expect(template.version).toBe(POLICY_TEMPLATE_VERSION);
    expect(template.principal.subjectClaim).toBe("sub");
    expect(template.principal.entity).toEqual({
      owner: { kind: "entity", name: "user" },
      localName: "authId",
    });
    expect(template.classes).toEqual(["member", "support", "admin"]);
    expect(template.claims).toEqual(["org"]);
    expect(Object.keys(template.decisions.rows).sort()).toEqual([
      "issue",
      "tag",
      "user",
    ]);
    expect(template.decisions.traits.taggable).toBeDefined();
    expect(template.decisions.fields["entity:issue/internalNotes"]).toBeDefined();
    expect(template.decisions.operations["entity:issue/rename:required"]).toBeDefined();
    expect(template.decisions.operations["trait:taggable/addTag:required"]).toBeDefined();
    expect(JSON.stringify(template)).not.toMatch(/function/i);
  });

  test("template serialization is deterministic", () => {
    const a = canonicalJson(compileTaggablePolicy());
    const b = canonicalJson(compileTaggablePolicy());
    expect(a).toBe(b);
    expect(() => JSON.parse(a)).not.toThrow();
  });

  test("binding produces a sealed installed artifact with canonical identities", () => {
    const installed = installTaggablePolicy();
    expect(isSealedInstalled(installed)).toBe(true);
    expect(installed.catalogId).toBe(catalog.catalogId);
    expect(installed.catalogVersion).toBe(catalog.catalogVersion);
    expect(installed.catalogFingerprint).toBe(catalog.fingerprint);
    expect(installed.policyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(installed.identities.operations.every((op) => op.catalog === "app")).toBe(
      true,
    );
    expect(
      installed.identities.operations.some(
        (op) =>
          op.owner.kind === "entity" &&
          op.owner.name === "issue" &&
          op.localName === "rename" &&
          op.target === "required",
      ),
    ).toBe(true);
    expect(installed.traitComposition.issue).toContain("taggable");
    expect(() => {
      (installed as { catalogId: string }).catalogId = "mutated";
    }).toThrow();
  });

  test("installed serialization is deterministic", () => {
    const a = canonicalJson({
      ...installTaggablePolicy(),
    });
    const b = canonicalJson({
      ...installTaggablePolicy(),
    });
    expect(a).toBe(b);
  });
});
