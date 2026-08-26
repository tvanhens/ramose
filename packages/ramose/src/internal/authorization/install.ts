/**
 * Effectful catalog binding. A template is validated against the
 * authoritative catalog and sealed as {@link InstalledAuthorizationIR}.
 */

import * as Effect from "effect/Effect";
import { canonicalJson, hashPolicy } from "./canonical.ts";
import { CatalogMismatch, InvalidIR } from "./errors.ts";
import type { CatalogBinding, InstalledAuthorizationIR, PolicyTemplateIR } from "./ir.ts";
import { CatalogResolver, type ResolvedCatalog } from "./services.ts";
import { recomputeRuleMetadata, validateSemantics } from "./validate.ts";

const identitiesMatch = (template: PolicyTemplateIR, catalog: ResolvedCatalog): string | undefined => {
  const have = {
    entities: new Set(catalog.identities.entities.map((e) => e.ns)),
    traits: new Set(catalog.identities.traits.map((t) => t.ns)),
    fields: new Set(catalog.identities.fields.map((f) => f.ident)),
    operations: new Set(catalog.identities.operations.map((o) => o.name)),
  };
  for (const entity of template.identities.entities) {
    if (!have.entities.has(entity.ns)) return `entity ${entity.ns} is not in the catalog`;
  }
  for (const trait of template.identities.traits) {
    if (!have.traits.has(trait.ns)) return `trait ${trait.ns} is not in the catalog`;
  }
  for (const field of template.identities.fields) {
    const listed = catalog.identities.fields.find((item) => item.ident === field.ident);
    if (listed === undefined) return `field ${field.ident} is not in the catalog`;
    if (canonicalJson(listed) !== canonicalJson(field)) {
      return `field ${field.ident} does not match the catalog`;
    }
  }
  for (const op of template.identities.operations) {
    const listed = catalog.identities.operations.find((item) => item.name === op.name);
    if (listed === undefined) return `operation ${op.name} is not in the catalog`;
    if (canonicalJson(listed) !== canonicalJson(op)) {
      return `operation ${op.name} does not match the catalog`;
    }
  }
  for (const name of template.classes) {
    if (!catalog.classes.includes(name)) return `class ${name} is not in the catalog`;
  }
  return undefined;
};

const seal = (template: PolicyTemplateIR, catalog: CatalogBinding): InstalledAuthorizationIR => {
  const rules = template.rules.map(recomputeRuleMetadata).sort((a, b) => a.id.localeCompare(b.id));
  const body = {
    version: template.version,
    principal: template.principal,
    classes: template.classes,
    claims: [...template.claims].sort(),
    identities: template.identities,
    rules,
    rows: template.rows,
    traits: template.traits,
    fields: template.fields,
    operations: template.operations,
  };
  const installed: InstalledAuthorizationIR = {
    form: "installed",
    catalog,
    policyHash: hashPolicy(body),
    ...body,
  };
  validateSemantics(installed);
  return Object.freeze(installed);
};

export const installAgainstCatalog = (
  template: PolicyTemplateIR,
  catalog: ResolvedCatalog,
): Effect.Effect<InstalledAuthorizationIR, InvalidIR | CatalogMismatch> =>
  Effect.gen(function* () {
    if (template.form !== "template") {
      return yield* Effect.fail(new InvalidIR({ reason: "install expects a policy template" }));
    }
    try {
      validateSemantics(template);
    } catch (error) {
      if (error instanceof InvalidIR) return yield* Effect.fail(error);
      return yield* Effect.fail(new InvalidIR({ reason: String(error) }));
    }
    const mismatch = identitiesMatch(template, catalog);
    if (mismatch !== undefined) {
      return yield* Effect.fail(new CatalogMismatch({ reason: mismatch }));
    }
    return seal(template, {
      databaseId: catalog.databaseId,
      catalogName: catalog.catalogName,
      catalogVersion: catalog.catalogVersion,
      schemaFingerprint: catalog.schemaFingerprint,
    });
  });

/** Bind a template using {@link CatalogResolver}. */
export const installAuthorization = (
  template: PolicyTemplateIR,
): Effect.Effect<InstalledAuthorizationIR, InvalidIR | CatalogMismatch, CatalogResolver> =>
  Effect.gen(function* () {
    const resolver = yield* CatalogResolver;
    const catalog = yield* resolver.resolve();
    return yield* installAgainstCatalog(template, catalog);
  });

export const catalogFromTemplate = (
  template: PolicyTemplateIR,
  binding?: Partial<CatalogBinding>,
): ResolvedCatalog => ({
  databaseId: binding?.databaseId ?? "compile-time",
  catalogName: binding?.catalogName ?? "compile-time",
  catalogVersion: binding?.catalogVersion ?? 1,
  schemaFingerprint: binding?.schemaFingerprint ?? hashPolicy(template.identities),
  identities: template.identities,
  classes: template.classes,
  claimKeys: template.claims,
});
