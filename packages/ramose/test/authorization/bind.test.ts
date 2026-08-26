import { describe, expect, test } from "bun:test";
import { revalidateInstalled } from "../../src/authorization/bind.ts";
import { catalog, compileLive, installTaggablePolicy } from "./fixtures.ts";
import { CatalogMismatch } from "../../src/internal/authorization/errors.ts";
import { semanticallyValidateInstalled } from "../../src/internal/authorization/validate.ts";
import { sha256Hex } from "../../src/internal/authorization/hash.ts";

describe("catalog binding", () => {
  test("cross-catalog identities fail validation", () => {
    const installed = JSON.parse(JSON.stringify(installTaggablePolicy()));
    installed.identities.entities[0].catalog = "other";
    expect(() =>
      semanticallyValidateInstalled(installed, catalog, sha256Hex),
    ).toThrow(CatalogMismatch);
  });

  test("stale catalog versions fail validation", () => {
    const installed = JSON.parse(JSON.stringify(installTaggablePolicy()));
    installed.catalogVersion = "v0";
    expect(() =>
      semanticallyValidateInstalled(installed, catalog, sha256Hex),
    ).toThrow(CatalogMismatch);
  });

  test("fingerprint mismatch fails validation", () => {
    const installed = JSON.parse(JSON.stringify(installTaggablePolicy()));
    installed.catalogFingerprint = "0".repeat(64);
    expect(() =>
      semanticallyValidateInstalled(installed, catalog, sha256Hex),
    ).toThrow(CatalogMismatch);
  });

  test("revalidation reseals a stored installed document", () => {
    const raw = JSON.parse(JSON.stringify(installTaggablePolicy()));
    const resealed = compileLive(revalidateInstalled(raw, catalog));
    expect(resealed.catalogId).toBe("app");
  });
});
