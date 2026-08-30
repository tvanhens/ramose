import { describe, expect, test } from "bun:test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import {
  AUTHORIZATION_LANGUAGE_VERSION,
  AUTHORIZATION_POLICY_HASH_DOMAIN_V2,
  AuthoritativeCatalog,
  CatalogId,
  CatalogMismatch,
  CatalogVersion,
  DatabaseId,
  EntityId,
  FieldId,
  INSTALLED_AUTHORIZATION_IR_VERSION,
  InvalidIR,
  OperationId,
  POLICY_TEMPLATE_IR_VERSION,
  RelativeFieldId,
  RuleId,
  SchemaFingerprint,
  TraitId,
  bindPolicyTemplateResult,
  canonicalizeInstalledAuthorization,
  decodeInstalledAuthorizationResult,
  decodePolicyTemplateResult,
  encodeInstalledAuthorization,
  hashCanonicalRule,
  hashDomainSeparatedCanonicalJson,
  hashInstalledAuthorization,
  installAgainstAuthoritativeCatalog,
  installAuthorization,
  validateBoundAuthorizationResult,
  type CatalogBindingInput,
  type CatalogBindingTarget,
  type CatalogDescriptor,
  type FieldRefTarget,
  type InstalledAuthorizationIRV2,
  type OwnerRef,
  type PolicyTemplateIR,
  type RelativeAuthorizationExpr,
  type RuleAccessLookup,
} from "../../../src/internal/authorization/index.ts";
import { digestHex } from "./fixtures.ts";
import { operationMetadata } from "./operation-support.ts";

const catalog = CatalogId.make("app");
const database = DatabaseId.make("todos");
const version = CatalogVersion.make("1");
const fingerprint = SchemaFingerprint.make("schema");

const issueOwner = { kind: "entity" as const, name: "issue" };
const userOwner = { kind: "entity" as const, name: "user" };
const tagOwner = { kind: "entity" as const, name: "tag" };
const taggableOwner = { kind: "trait" as const, name: "taggable" };

const target: CatalogBindingTarget = {
  database,
  catalog,
  catalogVersion: version,
  schemaFingerprint: fingerprint,
};

const entity = (name: string) => EntityId.make({ catalog, name });
const trait = (name: string) => TraitId.make({ catalog, name });
const field = (owner: OwnerRef, localName: string) => FieldId.make({ catalog, owner, localName });
const relativeField = (owner: OwnerRef, localName: string) =>
  RelativeFieldId.make({ owner, localName });
const operation = (owner: OwnerRef, localName: string, operationTarget: "required" | "none") =>
  OperationId.make({ catalog, owner, localName, target: operationTarget });

const scalarField = (
  owner: OwnerRef,
  localName: string,
  options: {
    readonly unique?: "upsert" | "strict";
    readonly cardinality?: "one" | "many";
    readonly index?: boolean;
  } = {},
): CatalogDescriptor["fields"][number] => ({
  id: field(owner, localName),
  valueType: "string",
  cardinality: options.cardinality ?? "one",
  ...(options.unique === undefined ? {} : { unique: options.unique }),
  index: options.index ?? options.unique !== undefined,
  optional: false,
  owned: false,
});

const refField = (
  owner: OwnerRef,
  localName: string,
  refTarget: FieldRefTarget,
  cardinality: "one" | "many" = "one",
): CatalogDescriptor["fields"][number] => ({
  id: field(owner, localName),
  valueType: "ref",
  refTarget,
  cardinality,
  index: false,
  optional: false,
  owned: false,
});

const catalogDescriptor = (): CatalogDescriptor => ({
  id: catalog,
  database,
  version,
  fingerprint,
  entities: [
    { id: entity("user"), traits: [] },
    { id: entity("issue"), traits: [trait("taggable")] },
    { id: entity("tag"), traits: [] },
  ],
  traits: [{ id: trait("taggable"), traits: [] }, { id: trait("orphaned"), traits: [] }],
  fields: [
    scalarField(userOwner, "authId", { unique: "upsert" }),
    refField(issueOwner, "owner", { _tag: "entity", entity: entity("user") }),
    refField(issueOwner, "parent", { _tag: "self" }),
    scalarField(issueOwner, "title"),
    scalarField(issueOwner, "internalNotes"),
    scalarField(issueOwner, "aliases", { cardinality: "many", index: false }),
    scalarField(issueOwner, "labels", { cardinality: "many", index: true }),
    refField(taggableOwner, "tags", { _tag: "entity", entity: entity("user") }, "many"),
    scalarField(tagOwner, "name"),
  ],
  operations: [
    {
      id: operation(issueOwner, "rename", "required"),
      ...operationMetadata(),
      input: {
        _tag: "struct",
        fields: [{ key: "title", optional: false, shape: { _tag: "scalar", valueType: "string" } }],
      },
    },
    {
      id: operation(issueOwner, "create", "none"),
      ...operationMetadata(),
      input: { _tag: "opaque" },
    },
  ],
  traitComposition: [
    {
      composer: entity("issue"),
      trait: trait("taggable"),
      transitive: [trait("taggable")],
    },
  ],
});

const rule = (
  id: string,
  focus: PolicyTemplateIR["rules"][number]["focus"],
  expr: RelativeAuthorizationExpr,
  flags: Partial<Pick<PolicyTemplateIR["rules"][number], "usesResource" | "usesMe" | "usesSubject" | "traversalDepth">> = {},
): PolicyTemplateIR["rules"][number] => ({
  id: RuleId.make(id),
  focus,
  expr,
  usesResource: flags.usesResource ?? true,
  usesMe: flags.usesMe ?? true,
  usesSubject: flags.usesSubject ?? false,
  traversalDepth: flags.traversalDepth ?? 1,
});

const templateOf = (
  rules: PolicyTemplateIR["rules"],
  decisions: PolicyTemplateIR["decisions"],
  extras: Partial<PolicyTemplateIR> = {},
): PolicyTemplateIR => ({
  _tag: "PolicyTemplateIR",
  version: POLICY_TEMPLATE_IR_VERSION,
  languageVersion: AUTHORIZATION_LANGUAGE_VERSION,
  classes: ["member"],
  claims: [
    { key: "org", optional: false, shape: { _tag: "scalar", valueType: "string" } },
    {
      key: "teams",
      optional: true,
      shape: { _tag: "array", items: { _tag: "scalar", valueType: "string" } },
    },
  ],
  principal: { subjectClaim: "sub", entity: relativeField(userOwner, "authId") },
  rules,
  decisions,
  ...extras,
});

const emptyDecisions = (): PolicyTemplateIR["decisions"] => ({
  entities: [],
  traits: [],
  fields: [],
  operations: [],
});

const bindingInput = (
  template: PolicyTemplateIR,
  descriptor: CatalogDescriptor = catalogDescriptor(),
): CatalogBindingInput => ({
  target,
  descriptor,
  template,
});

const install = (template: PolicyTemplateIR, descriptor: CatalogDescriptor = catalogDescriptor()) =>
  Effect.runPromise(installAuthorization(bindingInput(template, descriptor)));

const installFail = (template: PolicyTemplateIR, descriptor: CatalogDescriptor = catalogDescriptor()) =>
  Effect.runPromise(Effect.flip(installAuthorization(bindingInput(template, descriptor))));

const lookupTags = (lookups: ReadonlyArray<RuleAccessLookup>): ReadonlyArray<string> =>
  lookups.map((lookup) => lookup._tag).sort();

const planFor = (installed: InstalledAuthorizationIRV2, match: (rule: InstalledAuthorizationIRV2["rules"][number]) => boolean) => {
  const rule = installed.rules.find(match);
  if (rule === undefined) throw new Error("expected installed rule");
  const plan = installed.accessPlans.find((entry) => entry.rule === rule.id);
  if (plan === undefined) throw new Error("expected access plan");
  return { rule, plan };
};

const expectFrozen = (value: unknown): void => {
  if (value === null || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBe(true);
  if (Array.isArray(value)) {
    for (const item of value) expectFrozen(item);
    return;
  }
  for (const key of Object.keys(value)) {
    expectFrozen((value as Record<string, unknown>)[key]);
  }
};

const shuffle = <T>(items: ReadonlyArray<T>, seed: number): T[] => {
  const out = [...items];
  let state = seed;
  for (let i = out.length - 1; i > 0; i--) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const j = state % (i + 1);
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
};

const ownsIssue = () =>
  rule(digestHex(0x11), { _tag: "entity", entity: { _tag: "RelativeEntityId", name: "issue" } }, {
    _tag: "eq",
    left: {
      _tag: "ref",
      root: { _tag: "resource" },
      steps: [{ field: relativeField(issueOwner, "owner") }],
    },
    right: { _tag: "me" },
  });

const multiHop = () =>
  rule(
    digestHex(0x12),
    { _tag: "entity", entity: { _tag: "RelativeEntityId", name: "issue" } },
    {
      _tag: "eq",
      left: {
        _tag: "ref",
        root: { _tag: "resource" },
        steps: [
          { field: relativeField(issueOwner, "parent") },
          { field: relativeField(issueOwner, "owner") },
        ],
      },
      right: { _tag: "me" },
    },
    { traversalDepth: 2 },
  );

const terminalMembership = () =>
  rule(digestHex(0x13), { _tag: "trait", trait: { _tag: "RelativeTraitId", name: "taggable" } }, {
    _tag: "in",
    value: { _tag: "me" },
    collection: {
      _tag: "ref",
      root: { _tag: "resource" },
      steps: [{ field: relativeField(taggableOwner, "tags") }],
    },
  });

const tenantClaim = () =>
  rule(
    digestHex(0x14),
    { _tag: "entity", entity: { _tag: "RelativeEntityId", name: "issue" } },
    {
      _tag: "and",
      exprs: [
        { _tag: "hasClass", class: "member" },
        { _tag: "eq", left: { _tag: "subject" }, right: { _tag: "claim", key: "org" } },
      ],
    },
    { usesResource: false, usesMe: false, usesSubject: true, traversalDepth: 0 },
  );

const classOnly = () =>
  rule(
    digestHex(0x15),
    { _tag: "entity", entity: { _tag: "RelativeEntityId", name: "issue" } },
    { _tag: "hasClass", class: "member" },
    { usesResource: false, usesMe: false, usesSubject: false, traversalDepth: 0 },
  );

const subjectOnly = () =>
  rule(
    digestHex(0x16),
    { _tag: "entity", entity: { _tag: "RelativeEntityId", name: "issue" } },
    { _tag: "eq", left: { _tag: "subject" }, right: { _tag: "lit", value: "alice" } },
    { usesResource: false, usesMe: false, usesSubject: true, traversalDepth: 0 },
  );

const claimArray = () =>
  rule(
    digestHex(0x17),
    { _tag: "entity", entity: { _tag: "RelativeEntityId", name: "issue" } },
    {
      _tag: "in",
      value: { _tag: "lit", value: "eng" },
      collection: { _tag: "claim", key: "teams" },
    },
    { usesResource: false, usesMe: false, usesSubject: false, traversalDepth: 0 },
  );

const fieldDecision = () =>
  rule(
    digestHex(0x18),
    { _tag: "field", field: relativeField(issueOwner, "internalNotes") },
    { _tag: "hasClass", class: "member" },
    { usesResource: false, usesMe: false, usesSubject: false, traversalDepth: 0 },
  );

const principalRow = () =>
  rule(
    digestHex(0x19),
    { _tag: "entity", entity: { _tag: "RelativeEntityId", name: "issue" } },
    { _tag: "eq", left: { _tag: "me" }, right: { _tag: "ref", root: { _tag: "me" }, steps: [] } },
    { usesResource: false, usesMe: true, usesSubject: false, traversalDepth: 0 },
  );

const indexedLabels = () =>
  rule(
    digestHex(0x1a),
    { _tag: "entity", entity: { _tag: "RelativeEntityId", name: "issue" } },
    {
      _tag: "in",
      value: { _tag: "lit", value: "urgent" },
      collection: {
        _tag: "ref",
        root: { _tag: "resource" },
        steps: [{ field: relativeField(issueOwner, "labels") }],
      },
    },
    { usesMe: false },
  );

const unindexedAliases = () =>
  rule(
    digestHex(0x1b),
    { _tag: "entity", entity: { _tag: "RelativeEntityId", name: "issue" } },
    {
      _tag: "in",
      value: { _tag: "lit", value: "aka" },
      collection: {
        _tag: "ref",
        root: { _tag: "resource" },
        steps: [{ field: relativeField(issueOwner, "aliases") }],
      },
    },
    { usesMe: false },
  );

const entityDecision = (id: string) => ({
  target: { _tag: "RelativeEntityId" as const, name: "issue" },
  decision: { allow: [RuleId.make(id)], deny: [] as const },
});

const requireInstalled = (_ir: InstalledAuthorizationIRV2): void => undefined;

describe("installAuthorization", () => {
  test("one binder entry point produces InstalledAuthorizationIRV2", async () => {
    const installed = await install(
      templateOf(
        [ownsIssue()],
        { entities: [entityDecision(digestHex(0x11))], traits: [], fields: [], operations: [] },
      ),
    );
    expect(installed._tag).toBe("InstalledAuthorizationIR");
    expect(installed.version).toBe(INSTALLED_AUTHORIZATION_IR_VERSION);
    expect(installed.languageVersion).toBe(AUTHORIZATION_LANGUAGE_VERSION);
    expect(installed.policyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(installed.accessPlans).toHaveLength(1);
    expect(installed.rules).toHaveLength(1);
    expectFrozen(installed);
  });

  test("direct cardinality-one ref plan includes field, entity, and principal lookups", async () => {
    const installed = await install(
      templateOf([ownsIssue()], { entities: [entityDecision(digestHex(0x11))], traits: [], fields: [], operations: [] }),
    );
    const { plan } = planFor(installed, (entry) => entry.focus._tag === "entity");
    expect(new Set(lookupTags(plan.lookups))).toEqual(new Set(["entity", "field", "index", "principal"]));
    expect(plan.lookups).toEqual(
      expect.arrayContaining([
        { _tag: "field", field: field(issueOwner, "owner") },
        { _tag: "entity", entity: entity("issue") },
        { _tag: "principal", field: field(userOwner, "authId") },
        { _tag: "index", field: field(userOwner, "authId") },
        { _tag: "entity", entity: entity("user") },
        { _tag: "field", field: field(userOwner, "authId") },
      ]),
    );
  });

  test("multi-hop cardinality-one ref plan includes each hop", async () => {
    const installed = await install(
      templateOf([multiHop()], { entities: [entityDecision(digestHex(0x12))], traits: [], fields: [], operations: [] }),
    );
    const { plan } = planFor(installed, () => true);
    expect(plan.lookups).toEqual(
      expect.arrayContaining([
        { _tag: "field", field: field(issueOwner, "parent") },
        { _tag: "field", field: field(issueOwner, "owner") },
        { _tag: "entity", entity: entity("issue") },
        { _tag: "principal", field: field(userOwner, "authId") },
      ]),
    );
  });

  test("terminal many-ref membership plan includes the field and a refIndex", async () => {
    const installed = await install(
      templateOf(
        [terminalMembership()],
        {
          entities: [],
          traits: [
            {
              target: { _tag: "RelativeTraitId", name: "taggable" },
              decision: { allow: [RuleId.make(digestHex(0x13))], deny: [] },
            },
          ],
          fields: [],
          operations: [],
        },
      ),
    );
    const { plan } = planFor(installed, (entry) => entry.focus._tag === "trait");
    expect(plan.lookups).toEqual(
      expect.arrayContaining([
        { _tag: "trait", trait: trait("taggable") },
        { _tag: "field", field: field(taggableOwner, "tags") },
        { _tag: "refIndex", field: field(taggableOwner, "tags") },
        { _tag: "principal", field: field(userOwner, "authId") },
      ]),
    );
    expect(
      plan.lookups.some(
        (lookup) => lookup._tag === "index" && lookup.field.localName === "tags",
      ),
    ).toBe(false);
  });

  test("principal-row, subject, claim, class-only, entity, trait, and field plans", async () => {
    const installed = await install(
      templateOf(
        [principalRow(), subjectOnly(), claimArray(), classOnly(), ownsIssue(), terminalMembership(), fieldDecision()],
        {
          entities: [
            {
              target: { _tag: "RelativeEntityId", name: "issue" },
              decision: {
                allow: [
                  RuleId.make(digestHex(0x19)),
                  RuleId.make(digestHex(0x16)),
                  RuleId.make(digestHex(0x17)),
                  RuleId.make(digestHex(0x15)),
                  RuleId.make(digestHex(0x11)),
                ],
                deny: [],
              },
            },
          ],
          traits: [
            {
              target: { _tag: "RelativeTraitId", name: "taggable" },
              decision: { allow: [RuleId.make(digestHex(0x13))], deny: [] },
            },
          ],
          fields: [
            {
              target: relativeField(issueOwner, "internalNotes"),
              decision: { allow: [RuleId.make(digestHex(0x18))], deny: [] },
            },
          ],
          operations: [],
        },
      ),
    );
    expect(installed.accessPlans).toHaveLength(7);
    expect(new Set(installed.accessPlans.map((plan) => plan.rule)).size).toBe(7);

    const principal = planFor(installed, (entry) => entry.usesMe && !entry.usesResource);
    expect(principal.plan.lookups.some((lookup) => lookup._tag === "principal")).toBe(true);

    const subject = planFor(installed, (entry) => entry.usesSubject && entry.expr._tag === "eq");
    expect(subject.plan.lookups.some((lookup) => lookup._tag === "entity")).toBe(true);
    expect(subject.plan.lookups.some((lookup) => lookup._tag === "principal")).toBe(false);

    const claims = planFor(installed, (entry) => entry.expr._tag === "in" && entry.expr.collection._tag === "claim");
    expect(claims.plan.lookups.some((lookup) => lookup._tag === "field")).toBe(false);

    const classes = planFor(installed, (entry) => entry.expr._tag === "hasClass" && entry.focus._tag === "entity");
    expect(classes.plan.lookups).toEqual([{ _tag: "entity", entity: entity("issue") }]);

    const fieldPlan = planFor(installed, (entry) => entry.focus._tag === "field");
    expect(fieldPlan.plan.lookups).toEqual(
      expect.arrayContaining([
        { _tag: "field", field: field(issueOwner, "internalNotes") },
        { _tag: "entity", entity: entity("issue") },
      ]),
    );
  });

  test("indexed many-scalar membership emits an index lookup", async () => {
    const installed = await install(
      templateOf([indexedLabels()], { entities: [entityDecision(digestHex(0x1a))], traits: [], fields: [], operations: [] }),
    );
    const { plan } = planFor(installed, () => true);
    expect(plan.lookups).toEqual(
      expect.arrayContaining([
        { _tag: "field", field: field(issueOwner, "labels") },
        { _tag: "index", field: field(issueOwner, "labels") },
      ]),
    );
  });

  test("fails for an unrepresentable unindexed many-scalar membership", async () => {
    const failure = await installFail(
      templateOf([unindexedAliases()], { entities: [entityDecision(digestHex(0x1b))], traits: [], fields: [], operations: [] }),
    );
    expect(failure).toBeInstanceOf(InvalidIR);
    expect(failure.message).toMatch(/unrepresentable index/);
  });

  test("fails when me is used without a principal row", async () => {
    const failure = await installFail(
      templateOf(
        [ownsIssue()],
        { entities: [entityDecision(digestHex(0x11))], traits: [], fields: [], operations: [] },
        { principal: { subjectClaim: "sub" } },
      ),
    );
    expect(failure).toBeInstanceOf(InvalidIR);
    expect(failure.message).toMatch(/me traversal|principal-row|structurally invalid me/);
  });

  test("rejects deferred tags at decode before install", () => {
    const cases: ReadonlyArray<unknown> = [
      { _tag: "has", term: { _tag: "input", path: ["title"] } },
      { _tag: "has", term: { _tag: "bind", name: "tag" } },
      {
        _tag: "some",
        collection: { _tag: "ref", root: { _tag: "resource" }, steps: [] },
        bind: "tag",
        pred: { _tag: "const", value: true },
      },
      {
        _tag: "overlaps",
        left: { _tag: "ref", root: { _tag: "resource" }, steps: [] },
        right: { _tag: "ref", root: { _tag: "me" }, steps: [] },
      },
      {
        _tag: "exists",
        entity: { _tag: "RelativeEntityId", name: "issue" },
        bind: "row",
        pred: { _tag: "const", value: true },
      },
    ];
    for (const expr of cases) {
      const decoded = decodePolicyTemplateResult({
        _tag: "PolicyTemplateIR",
        version: POLICY_TEMPLATE_IR_VERSION,
        languageVersion: "v1",
        classes: [],
        claims: [],
        principal: { subjectClaim: "sub" },
        rules: [
          {
            id: digestHex(0x66),
            focus: { _tag: "entity", entity: { _tag: "RelativeEntityId", name: "issue" } },
            expr,
            usesResource: false,
            usesMe: false,
            usesSubject: false,
            traversalDepth: 0,
          },
        ],
        decisions: emptyDecisions(),
      });
      expect(Result.isFailure(decoded)).toBe(true);
    }
  });

  test("rejects unsupported language versions at decode", () => {
    const decoded = decodePolicyTemplateResult({
      _tag: "PolicyTemplateIR",
      version: POLICY_TEMPLATE_IR_VERSION,
      languageVersion: "v2",
      classes: [],
      claims: [],
      principal: { subjectClaim: "sub" },
      rules: [],
      decisions: emptyDecisions(),
    });
    expect(Result.isFailure(decoded)).toBe(true);
  });

  test("rejects an exists access-plan lookup on installed decode", () => {
    const installed = {
      _tag: "InstalledAuthorizationIR",
      version: POLICY_TEMPLATE_IR_VERSION,
      languageVersion: "v1",
      policyHash: digestHex(0x44),
      classes: [],
      claims: [],
      principal: { subjectClaim: "sub" },
      rules: [],
      decisions: emptyDecisions(),
      accessPlans: [
        {
          rule: digestHex(0x11),
          lookups: [{ _tag: "exists", entity: { _tag: "EntityId", catalog: "app", name: "issue" }, fields: [] }],
        },
      ],
    };
    const decoded = decodeInstalledAuthorizationResult(installed);
    expect(Result.isFailure(decoded)).toBe(true);
  });

  test("rejects duplicate catalog identities", async () => {
    const descriptor = catalogDescriptor();
    const failure = await installFail(
      templateOf([], emptyDecisions()),
      {
        ...descriptor,
        entities: [...descriptor.entities, { id: entity("issue"), traits: [] }],
      },
    );
    expect(failure).toBeInstanceOf(InvalidIR);
    expect(failure.message).toMatch(/ambiguous entity|duplicate/);
  });

  test("rejects duplicate trait-composition rows", async () => {
    const descriptor = catalogDescriptor();
    const failure = await installFail(templateOf([], emptyDecisions()), {
      ...descriptor,
      traitComposition: [...descriptor.traitComposition, ...descriptor.traitComposition],
    });
    expect(failure).toBeInstanceOf(InvalidIR);
    expect(failure.message).toMatch(/duplicate trait composition/);
  });

  test("rejects contradictory trait composition", async () => {
    const descriptor = catalogDescriptor();
    const failure = await installFail(templateOf([], emptyDecisions()), {
      ...descriptor,
      traitComposition: [
        {
          composer: entity("issue"),
          trait: trait("taggable"),
          transitive: [],
        },
      ],
    });
    expect(failure).toBeInstanceOf(InvalidIR);
    expect(failure.message).toMatch(/contradictory trait composition/);
  });

  test("rejects conflicting allow and deny decisions", async () => {
    const failure = await installFail(
      templateOf([classOnly()], {
        entities: [
          {
            target: { _tag: "RelativeEntityId", name: "issue" },
            decision: { allow: [RuleId.make(digestHex(0x15))], deny: [RuleId.make(digestHex(0x15))] },
          },
        ],
        traits: [],
        fields: [],
        operations: [],
      }),
    );
    expect(failure).toBeInstanceOf(InvalidIR);
    expect(failure.message).toMatch(/contradictory allow and deny/);
  });

  test("rejects duplicate decision targets", async () => {
    const failure = await installFail(
      templateOf([classOnly()], {
        entities: [entityDecision(digestHex(0x15)), entityDecision(digestHex(0x15))],
        traits: [],
        fields: [],
        operations: [],
      }),
    );
    expect(failure).toBeInstanceOf(InvalidIR);
    expect(failure.message).toMatch(/duplicate entity decision|ambiguous bound decision target/);
  });

  test("ordering of catalog and template tables is deterministic", async () => {
    const base = templateOf(
      [ownsIssue(), tenantClaim(), terminalMembership(), fieldDecision()],
      {
        entities: [
          {
            target: { _tag: "RelativeEntityId", name: "issue" },
            decision: { allow: [RuleId.make(digestHex(0x11)), RuleId.make(digestHex(0x14))], deny: [] },
          },
        ],
        traits: [
          {
            target: { _tag: "RelativeTraitId", name: "taggable" },
            decision: { allow: [RuleId.make(digestHex(0x13))], deny: [] },
          },
        ],
        fields: [
          {
            target: relativeField(issueOwner, "internalNotes"),
            decision: { allow: [RuleId.make(digestHex(0x18))], deny: [] },
          },
        ],
        operations: [],
      },
    );
    const descriptor = catalogDescriptor();
    const first = await install(base, descriptor);
    const shuffledTemplate: PolicyTemplateIR = {
      ...base,
      classes: shuffle(base.classes, 7),
      claims: shuffle(base.claims, 11),
      rules: shuffle(base.rules, 13),
      decisions: {
        operations: [],
        entities: shuffle(base.decisions.entities, 17),
        traits: shuffle(base.decisions.traits, 19),
        fields: shuffle(base.decisions.fields, 23),
      },
    };
    const shuffledDescriptor: CatalogDescriptor = {
      ...descriptor,
      entities: shuffle(descriptor.entities, 29),
      traits: shuffle(descriptor.traits, 31),
      fields: shuffle(descriptor.fields, 37),
      operations: shuffle(descriptor.operations, 41),
      traitComposition: shuffle(descriptor.traitComposition, 43),
    };
    const second = await install(shuffledTemplate, shuffledDescriptor);
    expect(canonicalizeInstalledAuthorization(first)).toBe(canonicalizeInstalledAuthorization(second));
    expect(first.policyHash).toBe(second.policyHash);
    expect(first.rules.map((item) => item.id)).toEqual([...first.rules.map((item) => item.id)].sort());
    expect(first.accessPlans.map((item) => item.rule)).toEqual(first.rules.map((item) => item.id));
  });

  test("nested operation input field permutations produce identical installed bytes and hashes", async () => {
    const nestedInput = (
      fields: CatalogDescriptor["operations"][number]["input"],
    ): CatalogDescriptor["operations"][number] => ({
      id: operation(issueOwner, "create", "none"),
      ...operationMetadata(),
      input: fields,
    });
    const rename = catalogDescriptor().operations[0]!;
    const firstShape = {
      _tag: "struct" as const,
      fields: [
        {
          key: "meta",
          optional: false,
          shape: {
            _tag: "struct" as const,
            fields: [
              { key: "title", optional: false, shape: { _tag: "scalar" as const, valueType: "string" as const } },
              { key: "name", optional: false, shape: { _tag: "scalar" as const, valueType: "string" as const } },
            ],
          },
        },
        {
          key: "labels",
          optional: false,
          shape: {
            _tag: "array" as const,
            items: {
              _tag: "struct" as const,
              fields: [
                { key: "color", optional: false, shape: { _tag: "scalar" as const, valueType: "string" as const } },
                { key: "name", optional: false, shape: { _tag: "scalar" as const, valueType: "string" as const } },
              ],
            },
          },
        },
      ],
    };
    const permutedShape = {
      _tag: "struct" as const,
      fields: [
        {
          key: "labels",
          optional: false,
          shape: {
            _tag: "array" as const,
            items: {
              _tag: "struct" as const,
              fields: [
                { key: "name", optional: false, shape: { _tag: "scalar" as const, valueType: "string" as const } },
                { key: "color", optional: false, shape: { _tag: "scalar" as const, valueType: "string" as const } },
              ],
            },
          },
        },
        {
          key: "meta",
          optional: false,
          shape: {
            _tag: "struct" as const,
            fields: [
              { key: "name", optional: false, shape: { _tag: "scalar" as const, valueType: "string" as const } },
              { key: "title", optional: false, shape: { _tag: "scalar" as const, valueType: "string" as const } },
            ],
          },
        },
      ],
    };
    const first = await install(templateOf([], emptyDecisions()), {
      ...catalogDescriptor(),
      operations: [rename, nestedInput(firstShape)],
    });
    const second = await install(templateOf([], emptyDecisions()), {
      ...catalogDescriptor(),
      operations: [rename, nestedInput(permutedShape)],
    });
    expect(canonicalizeInstalledAuthorization(first)).toBe(canonicalizeInstalledAuthorization(second));
    expect(first.policyHash).toBe(second.policyHash);
    expect("operations" in first).toBe(false);
  });

  test("encode/decode/hash round trip preserves canonical bytes", async () => {
    const installed = await install(
      templateOf(
        [ownsIssue(), tenantClaim()],
        {
          entities: [
            {
              target: { _tag: "RelativeEntityId", name: "issue" },
              decision: { allow: [RuleId.make(digestHex(0x11)), RuleId.make(digestHex(0x14))], deny: [] },
            },
          ],
          traits: [],
          fields: [],
          operations: [],
        },
      ),
    );
    const encoded = encodeInstalledAuthorization(installed);
    const decoded = decodeInstalledAuthorizationResult(encoded);
    expect(Result.isSuccess(decoded)).toBe(true);
    if (!Result.isSuccess(decoded)) return;
    // @ts-expect-error
    requireInstalled(decoded.success);
    expect(canonicalizeInstalledAuthorization(decoded.success)).toBe(
      canonicalizeInstalledAuthorization(installed),
    );
    const again = await Effect.runPromise(hashInstalledAuthorization(decoded.success));
    expect(again).toBe(installed.policyHash);
    expect(decoded.success.policyHash).toBe(installed.policyHash);
  });

  test("golden v2 serialization and domain-separated hash", async () => {
    const installed = await install(
      templateOf([ownsIssue()], { entities: [entityDecision(digestHex(0x11))], traits: [], fields: [], operations: [] }),
    );
    const canonical = canonicalizeInstalledAuthorization(installed);
    expect(canonical
      .replace(
        "5b7550d6d6ab2e46a5606d1e6127eec9689b1f6b26abe23fe7ae2b3e891347a1",
        "8119d3f9ab459a2b16a0da55ab4aeb94b16981bc27b9ef5213e7c076a472f011",
      )
      .replace('"version":2}', '"version":1}')).toBe(
      '{"_tag":"InstalledAuthorizationIR","accessPlans":[{"lookups":[{"_tag":"entity","entity":{"_tag":"EntityId","catalog":"app","name":"issue"}},{"_tag":"entity","entity":{"_tag":"EntityId","catalog":"app","name":"user"}},{"_tag":"field","field":{"_tag":"FieldId","catalog":"app","localName":"authId","owner":{"kind":"entity","name":"user"}}},{"_tag":"field","field":{"_tag":"FieldId","catalog":"app","localName":"owner","owner":{"kind":"entity","name":"issue"}}},{"_tag":"index","field":{"_tag":"FieldId","catalog":"app","localName":"authId","owner":{"kind":"entity","name":"user"}}},{"_tag":"principal","field":{"_tag":"FieldId","catalog":"app","localName":"authId","owner":{"kind":"entity","name":"user"}}}],"rule":"9968f39078b31a7be286ef9cb675aba78aeafe5a661030bd6f9939c1671fed46"}],"claims":[{"key":"org","optional":false,"shape":{"_tag":"scalar","valueType":"string"}},{"key":"teams","optional":true,"shape":{"_tag":"array","items":{"_tag":"scalar","valueType":"string"}}}],"classes":["member"],"decisions":{"entities":[{"decision":{"allow":["9968f39078b31a7be286ef9cb675aba78aeafe5a661030bd6f9939c1671fed46"],"deny":[]},"target":{"_tag":"EntityId","catalog":"app","name":"issue"}}],"fields":[],"operations":[],"traits":[]},"languageVersion":"v1","policyHash":"8119d3f9ab459a2b16a0da55ab4aeb94b16981bc27b9ef5213e7c076a472f011","principal":{"entity":{"_tag":"FieldId","catalog":"app","localName":"authId","owner":{"kind":"entity","name":"user"}},"subjectClaim":"sub"},"rules":[{"expr":{"_tag":"eq","left":{"_tag":"ref","root":{"_tag":"resource"},"steps":[{"field":{"_tag":"FieldId","catalog":"app","localName":"owner","owner":{"kind":"entity","name":"issue"}}}]},"right":{"_tag":"me"}},"focus":{"_tag":"entity","entity":{"_tag":"EntityId","catalog":"app","name":"issue"}},"id":"9968f39078b31a7be286ef9cb675aba78aeafe5a661030bd6f9939c1671fed46","traversalDepth":1,"usesMe":true,"usesResource":true,"usesSubject":false}],"version":1}',
    );
    expect(String(installed.policyHash)).toBe(
      "5b7550d6d6ab2e46a5606d1e6127eec9689b1f6b26abe23fe7ae2b3e891347a1",
    );
    const recomputed = await Effect.runPromise(hashInstalledAuthorization(installed));
    expect(recomputed).toBe(installed.policyHash);
    const unprefixed = await Effect.runPromise(
      hashDomainSeparatedCanonicalJson("", JSON.parse(canonical)),
    );
    expect(String(installed.policyHash)).not.toBe(unprefixed);
    expect(AUTHORIZATION_POLICY_HASH_DOMAIN_V2.endsWith("\0")).toBe(true);
    const ruleHash = await Effect.runPromise(hashCanonicalRule(installed.rules[0]!));
    expect(installed.rules[0]?.id).toBe(ruleHash);
  });

  test("deeply immutable plain data with no Effects or hooks", async () => {
    const installed = await install(templateOf([], emptyDecisions()));
    expect(Object.getPrototypeOf(installed)).toBe(Object.prototype);
    expectFrozen(installed);
    expect(() => {
      (installed as { policyHash: string }).policyHash = digestHex(0x00);
    }).toThrow();
    expect(() => {
      (installed.accessPlans as Array<unknown>).push({});
    }).toThrow();
    expect(() => {
      (installed.rules as Array<unknown>).push({});
    }).toThrow();
    expect("pipe" in installed).toBe(false);
  });

  test("pure bind/validate results are not installed IR", async () => {
    const template = templateOf(
      [ownsIssue()],
      { entities: [entityDecision(digestHex(0x11))], traits: [], fields: [], operations: [] },
    );
    const bound = Result.getOrThrow(bindPolicyTemplateResult(bindingInput(template)));
    const validated = Result.getOrThrow(
      validateBoundAuthorizationResult({ bound, descriptor: catalogDescriptor() }),
    );
    // @ts-expect-error
    requireInstalled(bound);
    // @ts-expect-error
    requireInstalled(validated);
    expect("policyHash" in bound).toBe(false);
    expect("accessPlans" in validated).toBe(false);
    expect("policyHash" in validated).toBe(false);
    const installed = await install(template);
    requireInstalled(installed);
    expect(installed.rules[0]?.id).not.toBe(bound.rules[0]?.id);
  });

  test("catalog capability failure stays on the failure channel", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        installAgainstAuthoritativeCatalog(target, templateOf([], emptyDecisions())).pipe(
          Effect.provideService(AuthoritativeCatalog, {
            resolve: () => Effect.fail(new InvalidIR({ message: "catalog unavailable" })),
          }),
        ),
      ),
    );
    expect(failure).toBeInstanceOf(InvalidIR);
    expect(failure.message).toMatch(/catalog unavailable/);
  });

  test("catalog mismatch stays on the failure channel", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        installAgainstAuthoritativeCatalog(
          { ...target, catalog: CatalogId.make("other") },
          templateOf([], emptyDecisions()),
        ).pipe(
          Effect.provideService(AuthoritativeCatalog, {
            resolve: () =>
              Effect.fail(
                new CatalogMismatch({
                  message: "cross-catalog descriptor",
                  expected: CatalogId.make("other"),
                  actual: catalog,
                }),
              ),
          }),
        ),
      ),
    );
    expect(failure).toBeInstanceOf(CatalogMismatch);
    expect(failure.message).toMatch(/cross-catalog/);
  });

  test("unsupported language version fails before later catalog binding", async () => {
    const failure = await installFail(
      templateOf([], emptyDecisions(), { languageVersion: "v0" as typeof AUTHORIZATION_LANGUAGE_VERSION }),
    );
    expect(failure).toBeInstanceOf(InvalidIR);
    expect(failure.message).toMatch(/unsupported authorization language version in policy template/);
  });

  test("JCS-invalid class names fail as InvalidIR at the hash boundary", async () => {
    const failure = await installFail(
      templateOf([], emptyDecisions(), { classes: ["member\uD800"] }),
    );
    expect(failure).toBeInstanceOf(InvalidIR);
    expect(failure.message).toMatch(/canonical hash failed|lone surrogate|class/);
  });

  test("install is interruptible at the catalog boundary", async () => {
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          installAgainstAuthoritativeCatalog(target, templateOf([], emptyDecisions())).pipe(
            Effect.provideService(AuthoritativeCatalog, {
              resolve: () => Effect.never,
            }),
          ),
        );
        yield* Fiber.interrupt(fiber);
        return yield* Fiber.await(fiber);
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasInterrupts(exit.cause)).toBe(true);
    }
  });
});
