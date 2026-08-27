/**
 * #339: raw / rule / authorized snapshots are distinct capabilities.
 */
import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Connection } from "../../../src/internal/core/conn.ts";
import {
  AUTHORIZATION_LANGUAGE_VERSION,
  AuthorizationBudgetExceeded,
  CatalogId,
  CatalogMismatch,
  CatalogVersion,
  DatabaseId,
  EntityId,
  FieldId,
  IncompleteRuleSnapshot,
  InvalidIR,
  InvalidTraversal,
  LeaseExpired,
  MAX_READ_LEASE_MS,
  POLICY_TEMPLATE_IR_VERSION,
  RelativeFieldId,
  RuleId,
  SchemaFingerprint,
  TraitId,
  decodeInstalledAuthorizationResult,
  encodeInstalledAuthorization,
  installAuthorization,
  isVerifiedInstalledAuthorization,
  type CatalogBindingInput,
  type CatalogBindingTarget,
  type CatalogDescriptor,
  type FieldRefTarget,
  type InstalledAuthorizationIRV1,
  type OwnerRef,
  type PolicyTemplateIR,
  type RelativeAuthorizationExpr,
} from "../../../src/internal/authorization/index.ts";
import { queryAuthorized, pullAuthorized } from "../../../src/internal/authorization/runtime/application-read.ts";
import { AuthorizedApplicationAccess } from "../../../src/internal/authorization/runtime/application-snapshot.ts";
import {
  collapseApplicationBasis,
  effectiveApplicationT,
  mergeSnapshotBases,
} from "../../../src/internal/authorization/runtime/basis.ts";
import { issueAdmissionTicket } from "../../../src/internal/authorization/runtime/authentication.ts";
import {
  ApplicationSnapshotUnavailable,
  AuthenticationRejected,
  SnapshotCancelled,
} from "../../../src/internal/authorization/runtime/failures.ts";
import {
  authorizedSnapshotLayer,
  denyAllCapabilityLayer,
  evaluatorRuleSnapshotLayer,
  rawOnlyCapabilityLayer,
  rawStorageFromDb,
  scopedAuthorizedSnapshot,
  scopedRawSnapshot,
  scopedRuleSnapshot,
  trustedSnapshotLayer,
} from "../../../src/internal/authorization/runtime/layers.ts";
import { createLeaseState } from "../../../src/internal/authorization/runtime/lease.ts";
import { projectFetched } from "../../../src/internal/authorization/runtime/projection.ts";
import { RawStorageAccess } from "../../../src/internal/authorization/runtime/raw-storage.ts";
import { RuleSnapshotAccess } from "../../../src/internal/authorization/runtime/rule-snapshot.ts";
import {
  AuthorizedSnapshot,
  RawSnapshot,
  RuleSnapshot,
  fieldDescriptorKey,
  fieldStorageIndex,
  inspectAuthorizedSnapshot,
  inspectRawSnapshot,
  inspectRuleSnapshot,
  invalidateAuthorizedSnapshot,
  invalidateRawSnapshot,
  invalidateRuleSnapshot,
  physicalCurrentDb,
  physicalStorageIdent,
  physicalViewDb,
} from "../../../src/internal/authorization/runtime/snapshots.ts";
import { digestHex } from "./fixtures.ts";

const catalog = CatalogId.make("app");
const database = DatabaseId.make("todos");
const version = CatalogVersion.make("1");
const fingerprint = SchemaFingerprint.make("schema");
const issueOwner = { kind: "entity" as const, name: "issue" };
const userOwner = { kind: "entity" as const, name: "user" };

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

const scalarField = (
  owner: OwnerRef,
  localName: string,
  options: { readonly unique?: "upsert" | "strict" } = {},
): CatalogDescriptor["fields"][number] => ({
  id: field(owner, localName),
  valueType: "string",
  cardinality: "one",
  ...(options.unique === undefined ? {} : { unique: options.unique }),
  index: options.unique !== undefined,
  optional: false,
  owned: false,
});

const refField = (
  owner: OwnerRef,
  localName: string,
  refTarget: FieldRefTarget,
): CatalogDescriptor["fields"][number] => ({
  id: field(owner, localName),
  valueType: "ref",
  refTarget,
  cardinality: "one",
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
  ],
  traits: [{ id: trait("taggable"), traits: [] }],
  fields: [
    scalarField(userOwner, "authId", { unique: "upsert" }),
    scalarField(issueOwner, "title"),
    refField(issueOwner, "owner", { _tag: "entity", entity: entity("user") }),
    refField(issueOwner, "parent", { _tag: "self" }),
    refField(issueOwner, "link", { _tag: "untargeted" }),
    {
      id: field(issueOwner, "labels"),
      valueType: "string",
      cardinality: "many",
      index: false,
      optional: true,
      owned: false,
    },
    scalarField({ kind: "trait", name: "taggable" }, "tag"),
  ],
  operations: [],
  traitComposition: [
    { composer: entity("issue"), trait: trait("taggable"), transitive: [trait("taggable")] },
  ],
});

const rule = (
  id: string,
  expr: RelativeAuthorizationExpr,
): PolicyTemplateIR["rules"][number] => ({
  id: RuleId.make(id),
  focus: { _tag: "entity", entity: { _tag: "RelativeEntityId", name: "issue" } },
  expr,
  usesResource: true,
  usesMe: true,
  usesSubject: false,
  traversalDepth: 1,
});

const template = (): PolicyTemplateIR => ({
  _tag: "PolicyTemplateIR",
  version: POLICY_TEMPLATE_IR_VERSION,
  languageVersion: AUTHORIZATION_LANGUAGE_VERSION,
  classes: ["member"],
  claims: [{ key: "org", optional: false, shape: { _tag: "scalar", valueType: "string" } }],
  principal: { subjectClaim: "sub", entity: relativeField(userOwner, "authId") },
  rules: [
    rule(digestHex(0x11), {
      _tag: "eq",
      left: {
        _tag: "ref",
        root: { _tag: "resource" },
        steps: [{ field: relativeField(issueOwner, "owner") }],
      },
      right: { _tag: "me" },
    }),
  ],
  decisions: {
    entities: [
      {
        target: { _tag: "RelativeEntityId", name: "issue" },
        decision: { allow: [RuleId.make(digestHex(0x11))], deny: [] },
      },
    ],
    traits: [],
    fields: [],
  },
});

const bindingInput = (descriptor: CatalogDescriptor = catalogDescriptor()): CatalogBindingInput => ({
  target,
  descriptor,
  template: template(),
});

const principal = {
  subject: "ada",
  claims: { org: "acme" },
  classes: ["member"],
  me: { entity: entity("user"), eid: 0 },
};

const admit = (
  who: typeof principal = principal,
  options: {
    readonly database?: DatabaseId;
    readonly leaseEpoch?: number;
    readonly expiresAt?: number;
  } = {},
) =>
  issueAdmissionTicket({
    principal: who,
    database: options.database ?? database,
    leaseEpoch: options.leaseEpoch ?? 0,
    expiresAt: options.expiresAt ?? Date.now() + 4_000,
  });

const SCHEMA = [
  { ":db/ident": ":app.entity.user/authId", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/unique": ":db.unique/identity" },
  { ":db/ident": ":app.entity.issue/title", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one" },
  { ":db/ident": ":app.entity.issue/owner", ":db/valueType": ":db.type/ref", ":db/cardinality": ":db.cardinality/one" },
  { ":db/ident": ":app.entity.issue/parent", ":db/valueType": ":db.type/ref", ":db/cardinality": ":db.cardinality/one", ":db/optional": true },
  { ":db/ident": ":app.entity.issue/link", ":db/valueType": ":db.type/ref", ":db/cardinality": ":db.cardinality/one", ":db/optional": true },
  { ":db/ident": ":app.entity.issue/labels", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/many" },
  { ":db/ident": ":app.trait.taggable/tag", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/optional": true },
];

const setup = async () => {
  const installed = await Effect.runPromise(installAuthorization(bindingInput()));
  const conn = await Connection.create({ now: () => 1_700_000_000_000 });
  await conn.transact(SCHEMA);
  const report = await conn.transact([
    { ":db/id": "ada", ":app.entity.user/authId": "ada" },
    { ":db/id": "issue", ":app.entity.issue/title": "Secret", ":app.entity.issue/owner": "ada" },
  ]);
  const db = conn.db();
  return {
    installed,
    conn,
    db,
    ada: report.tempids.ada as number,
    issue: report.tempids.issue as number,
    descriptor: catalogDescriptor(),
  };
};

describe("basis arithmetic", () => {
  test("effective t prefers a smaller as-of", () => {
    expect(effectiveApplicationT(10)).toBe(10);
    expect(effectiveApplicationT(10, 4)).toBe(4);
    expect(effectiveApplicationT(10, 12)).toBe(10);
  });

  test("application collapse keeps history and as-of separate from the rule basis", () => {
    const application = collapseApplicationBasis({ basisT: 9, asOfT: 3, history: true });
    expect(application).toEqual({ basisT: 9, asOfT: 3, history: true, effectiveT: 3 });
    expect(mergeSnapshotBases(application, 9)).toEqual({ application, ruleBasisT: 9 });
  });
});

describe("pure projection cells", () => {
  test("fetched datoms distinguish absent entity, absent field, and present values", () => {
    const present = { e: 1, a: 2, v: "Secret", vt: 3, t: 1, op: true } as const;
    expect(projectFetched([], [], false)._tag).toBe("EntityAbsent");
    expect(projectFetched([present], [], false)._tag).toBe("FieldAbsent");
    expect(projectFetched([present], [present], false)).toEqual({ _tag: "Present", value: "Secret" });
    expect(projectFetched([present], [present, { ...present, v: "Other" }], true)).toEqual({
      _tag: "Present",
      value: ["Secret", "Other"],
    });
  });

  test("physical storage idents include catalog and owner kind", () => {
    expect(physicalStorageIdent(field(issueOwner, "title"))).toBe(":app.entity.issue/title");
    const unique = fieldStorageIndex([scalarField(issueOwner, "title")]);
    expect(unique.get(fieldDescriptorKey(field(issueOwner, "title")))).toBe(":app.entity.issue/title");
    const entityAndTrait = fieldStorageIndex([
      scalarField(issueOwner, "title"),
      scalarField({ kind: "trait", name: "issue" }, "title"),
    ]);
    expect(entityAndTrait.get(fieldDescriptorKey(field(issueOwner, "title")))).toBe(
      ":app.entity.issue/title",
    );
    expect(entityAndTrait.get(fieldDescriptorKey(field({ kind: "trait", name: "issue" }, "title")))).toBe(
      ":app.trait.issue/title",
    );
    const otherTitle = {
      ...scalarField(issueOwner, "title"),
      id: FieldId.make({ catalog: CatalogId.make("other"), owner: issueOwner, localName: "title" }),
    };
    const crossCatalog = fieldStorageIndex([scalarField(issueOwner, "title"), otherTitle]);
    expect(crossCatalog.get(fieldDescriptorKey(field(issueOwner, "title")))).toBe(":app.entity.issue/title");
    expect(crossCatalog.get(fieldDescriptorKey(otherTitle.id))).toBe(":other.entity.issue/title");
  });
});

describe("snapshot construction", () => {
  test("raw, rule, and authorized snapshots expose explicit bases", async () => {
    const { db, installed, ada, issue, descriptor } = await setup();
    const program = Effect.gen(function* () {
      const rawSvc = yield* RawStorageAccess;
      const ruleSvc = yield* RuleSnapshotAccess;
      const appSvc = yield* AuthorizedApplicationAccess;
      const raw = yield* rawSvc.open({ database, basisT: db.basisT, asOfT: db.basisT - 1, history: true });
      const rules = yield* ruleSvc.project({
        raw,
        installed,
        catalog: descriptor,
        ticket: admit({ ...principal, me: { entity: entity("user"), eid: ada } }),
        basisT: db.basisT,
      });
      const auth = yield* appSvc.open({
        raw,
        ticket: admit({ ...principal, me: { entity: entity("user"), eid: ada } }, { leaseEpoch: 3 }),
        installed,
        catalog,
        catalogVersion: version,
        database,
        applicationBasisT: db.basisT,
        ruleBasisT: db.basisT,
        leaseEpoch: 3,
        asOfT: db.basisT - 1,
        history: true,
      });
      const title = yield* ruleSvc.lookup(rules, issue, field(issueOwner, "title"));
      const owner = yield* ruleSvc.traverse(rules, issue, [field(issueOwner, "owner")]);
      const queried = yield* queryAuthorized(auth, { find: ["?t"], where: [["?e", ":issue/title", "?t"]] });
      const pulled = yield* pullAuthorized(auth, issue, [":issue/title"]);
      return { raw, rules, auth, title, owner, queried, pulled };
    }).pipe(Effect.provide(trustedSnapshotLayer({ open: () => Effect.succeed(db) })));

    const out = await Effect.runPromise(program);
    expect(out.raw).toBeInstanceOf(RawSnapshot);
    expect(out.rules).toBeInstanceOf(RuleSnapshot);
    expect(out.auth).toBeInstanceOf(AuthorizedSnapshot);
    expect(inspectRawSnapshot(out.raw)).toMatchObject({
      database,
      basisT: db.basisT,
      asOfT: db.basisT - 1,
      history: true,
      effectiveT: db.basisT - 1,
    });
    expect(inspectRuleSnapshot(out.rules)).toMatchObject({
      database,
      catalog,
      catalogVersion: version,
      basisT: db.basisT,
      policyHash: installed.policyHash,
    });
    expect(inspectAuthorizedSnapshot(out.auth)).toMatchObject({
      database,
      catalog,
      catalogVersion: version,
      basisT: db.basisT,
      ruleBasisT: db.basisT,
      asOfT: db.basisT - 1,
      history: true,
      leaseEpoch: 3,
    });
    expect(out.title).toEqual({ _tag: "Present", value: "Secret" });
    expect(out.owner).toEqual({ _tag: "Present", value: ada });
    expect(out.queried).toEqual([]);
    expect(out.pulled).toBeNull();
    expect(physicalCurrentDb(out.raw)).toBe(db);
  });

  test("missing principal, catalog, or unsealed IR cannot construct an authorized snapshot", async () => {
    const { db, installed, descriptor } = await setup();
    const encoded = encodeInstalledAuthorization(installed);
    const structural = decodeInstalledAuthorizationResult(encoded);
    expect(structural._tag).toBe("Success");
    expect(isVerifiedInstalledAuthorization(installed)).toBe(true);
    expect(isVerifiedInstalledAuthorization(structural._tag === "Success" ? structural.success : null)).toBe(false);

    const program = Effect.gen(function* () {
      const raw = yield* RawStorageAccess;
      const app = yield* AuthorizedApplicationAccess;
      const opened = yield* raw.open({ database, basisT: db.basisT });
      const blankPrincipal = yield* Effect.flip(app.open({
        raw: opened,
        ticket: issueAdmissionTicket({
          principal: { subject: "", claims: {}, classes: [] },
          database,
          leaseEpoch: 0,
          expiresAt: Date.now() + 4_000,
        }),
        installed,
        catalog,
        catalogVersion: version,
        database,
        applicationBasisT: db.basisT,
        ruleBasisT: db.basisT,
      }));
      const forgedTicket = yield* Effect.flip(app.open({
        raw: opened,
        ticket: {
          principal,
          database,
          leaseEpoch: 0,
          expiresAt: Date.now() + 4_000,
        },
        installed,
        catalog,
        catalogVersion: version,
        database,
        applicationBasisT: db.basisT,
        ruleBasisT: db.basisT,
      }));
      const unsealed = yield* Effect.flip(app.open({
        raw: opened,
        ticket: admit(),
        installed: (structural._tag === "Success" ? structural.success : installed) as InstalledAuthorizationIRV1,
        catalog,
        catalogVersion: version,
        database,
        applicationBasisT: db.basisT,
        ruleBasisT: db.basisT,
      }));
      const mismatch = yield* Effect.flip(app.open({
        raw: opened,
        ticket: admit(),
        installed,
        catalog: CatalogId.make("other"),
        catalogVersion: version,
        database,
        applicationBasisT: db.basisT,
        ruleBasisT: db.basisT,
      }));
      const rules = yield* RuleSnapshotAccess;
      const ruleMismatch = yield* Effect.flip(rules.project({
        raw: opened,
        installed,
        catalog: { ...descriptor, id: CatalogId.make("other") },
        ticket: admit(),
        basisT: db.basisT,
      }));
      return { blankPrincipal, forgedTicket, unsealed, mismatch, ruleMismatch };
    }).pipe(Effect.provide(trustedSnapshotLayer({ open: () => Effect.succeed(db) })));

    const out = await Effect.runPromise(program);
    expect(out.blankPrincipal).toBeInstanceOf(AuthenticationRejected);
    expect(out.forgedTicket).toBeInstanceOf(AuthenticationRejected);
    expect(out.unsealed).toBeInstanceOf(InvalidIR);
    expect(out.mismatch).toBeInstanceOf(CatalogMismatch);
    expect(out.ruleMismatch).toBeInstanceOf(CatalogMismatch);
  });

  test("deny or raw-only Layers cannot yield a privileged snapshot", async () => {
    const { db, installed } = await setup();
    const denied = await Effect.runPromise(
      Effect.gen(function* () {
        const raw = yield* RawStorageAccess;
        const app = yield* AuthorizedApplicationAccess;
        return {
          raw: yield* Effect.flip(raw.open({ database, basisT: 1 })),
          app: yield* Effect.flip(app.open({} as never)),
        };
      }).pipe(Effect.provide(denyAllCapabilityLayer)),
    );
    expect(denied.raw._tag).toBe("RawStorageUnavailable");
    expect(denied.app._tag).toBe("ApplicationSnapshotUnavailable");

    const rawOnly = await Effect.runPromise(
      Effect.gen(function* () {
        const raw = yield* RawStorageAccess;
        const app = yield* AuthorizedApplicationAccess;
        const opened = yield* raw.open({ database, basisT: db.basisT });
        const failed = yield* Effect.flip(app.open({
          raw: opened,
          ticket: admit(),
          installed,
          catalog,
          catalogVersion: version,
          database,
          applicationBasisT: db.basisT,
          ruleBasisT: db.basisT,
          leaseEpoch: 0,
        }));
        return { opened, failed };
      }).pipe(Effect.provide(rawOnlyCapabilityLayer(db, database))),
    );
    expect(rawOnly.opened).toBeInstanceOf(RawSnapshot);
    expect(rawOnly.failed).toBeInstanceOf(ApplicationSnapshotUnavailable);
  });

  test("cancellation and lease expiry prevent further use", async () => {
    const { db, installed, issue } = await setup();
    const program = Effect.gen(function* () {
      const rawSvc = yield* RawStorageAccess;
      const ruleSvc = yield* RuleSnapshotAccess;
      const appSvc = yield* AuthorizedApplicationAccess;
      const raw = yield* rawSvc.open({ database, basisT: db.basisT, expiresAt: Date.now() - 1 });
      const liveRaw = yield* rawSvc.open({ database, basisT: db.basisT });
      const rules = yield* ruleSvc.project({
        raw: liveRaw,
        installed,
        catalog: catalogDescriptor(),
        ticket: admit(),
        basisT: db.basisT,
      });
      const auth = yield* appSvc.open({
        raw: liveRaw,
        ticket: admit(principal, { leaseEpoch: 1 }),
        installed,
        catalog,
        catalogVersion: version,
        database,
        applicationBasisT: db.basisT,
        ruleBasisT: db.basisT,
        leaseEpoch: 1,
      });
      invalidateRawSnapshot(liveRaw);
      invalidateRuleSnapshot(rules);
      invalidateAuthorizedSnapshot(auth);
      return {
        expired: inspectRawSnapshot(raw).expiresAt < Date.now(),
        cancelledRaw: inspectRawSnapshot(liveRaw).cancelled,
        cancelledRule: inspectRuleSnapshot(rules).cancelled,
        cancelledAuth: inspectAuthorizedSnapshot(auth).cancelled,
        query: yield* Effect.flip(queryAuthorized(auth, {})),
        lookup: yield* Effect.flip(ruleSvc.lookup(rules, issue, field(issueOwner, "title"))),
      };
    }).pipe(Effect.provide(trustedSnapshotLayer({ open: () => Effect.succeed(db) })));

    const out = await Effect.runPromise(program);
    expect(out.expired).toBe(true);
    expect(out.cancelledRaw).toBe(true);
    expect(out.cancelledRule).toBe(true);
    expect(out.cancelledAuth).toBe(true);
    expect(out.query).toBeInstanceOf(SnapshotCancelled);
    expect(out.lookup).toBeInstanceOf(SnapshotCancelled);
  });

  test("scoped snapshots cancel on release", async () => {
    const { db, installed } = await setup();
    const program = Effect.scoped(Effect.gen(function* () {
      const raw = yield* scopedRawSnapshot({ database, basisT: db.basisT });
      const rules = yield* scopedRuleSnapshot({
        raw,
        installed,
        catalog: catalogDescriptor(),
        ticket: admit(),
        basisT: db.basisT,
      });
      const auth = yield* scopedAuthorizedSnapshot({
        raw,
        ticket: admit(principal, { leaseEpoch: 1 }),
        installed,
        catalog,
        catalogVersion: version,
        database,
        applicationBasisT: db.basisT,
        ruleBasisT: db.basisT,
        leaseEpoch: 1,
      });
      return { raw, rules, auth };
    })).pipe(Effect.provide(trustedSnapshotLayer({ open: () => Effect.succeed(db) })));

    const out = await Effect.runPromise(program);
    expect(inspectRawSnapshot(out.raw).cancelled).toBe(true);
    expect(inspectRuleSnapshot(out.rules).cancelled).toBe(true);
    expect(inspectAuthorizedSnapshot(out.auth).cancelled).toBe(true);
    const after = await Effect.runPromise(Effect.flip(queryAuthorized(out.auth, {})));
    expect(after).toBeInstanceOf(SnapshotCancelled);
  });

  test("rule lookup does not appear on the authorized snapshot", async () => {
    const { db, installed, issue, ada } = await setup();
    const program = Effect.gen(function* () {
      const raw = yield* RawStorageAccess;
      const rules = yield* RuleSnapshotAccess;
      const app = yield* AuthorizedApplicationAccess;
      const opened = yield* raw.open({ database, basisT: db.basisT });
      const ruleSnap = yield* rules.project({
        raw: opened,
        installed,
        catalog: catalogDescriptor(),
        ticket: admit({ ...principal, me: { entity: entity("user"), eid: ada } }),
        basisT: db.basisT,
      });
      const auth = yield* app.open({
        raw: opened,
        ticket: admit({ ...principal, me: { entity: entity("user"), eid: ada } }),
        installed,
        catalog,
        catalogVersion: version,
        database,
        applicationBasisT: db.basisT,
        ruleBasisT: db.basisT,
        leaseEpoch: 0,
      });
      const hidden = yield* rules.lookup(ruleSnap, issue, field(issueOwner, "title"));
      const visible = yield* queryAuthorized(auth, { find: ["?t"], where: [["?e", ":issue/title", "?t"]] });
      return { hidden, visible };
    }).pipe(Effect.provide(trustedSnapshotLayer({ open: () => Effect.succeed(db) })));

    const out = await Effect.runPromise(program);
    expect(out.hidden).toEqual({ _tag: "Present", value: "Secret" });
    expect(out.visible).toEqual([]);
  });

  test("evaluator rule service stays unwired for leftover evaluation", async () => {
    const { db, installed } = await setup();
    const program = Effect.gen(function* () {
      const raw = yield* RawStorageAccess;
      const rules = yield* RuleSnapshotAccess;
      const opened = yield* raw.open({ database, basisT: db.basisT });
      const snap = yield* rules.project({
        raw: opened,
        installed,
        catalog: catalogDescriptor(),
        ticket: admit(),
        basisT: db.basisT,
      });
      return yield* Effect.flip(rules.evaluateRule(snap, digestHex(0x11)));
    }).pipe(Effect.provide(Layer.mergeAll(rawStorageFromDb(db, database), evaluatorRuleSnapshotLayer)));

    const failed = await Effect.runPromise(program);
    expect(failed._tag).toBe("RuleSnapshotUnavailable");
  });

  test("expired lease is a typed failure on application reads", async () => {
    const { db, installed } = await setup();
    const program = Effect.gen(function* () {
      const raw = yield* RawStorageAccess;
      const app = yield* AuthorizedApplicationAccess;
      const opened = yield* raw.open({ database, basisT: db.basisT });
      const auth = yield* app.open({
        raw: opened,
        ticket: admit(),
        installed,
        catalog,
        catalogVersion: version,
        database,
        applicationBasisT: db.basisT,
        ruleBasisT: db.basisT,
        leaseEpoch: 0,
        expiresAt: Date.now() - 5,
      });
      return yield* Effect.flip(queryAuthorized(auth, {}));
    }).pipe(Effect.provide(Layer.mergeAll(rawStorageFromDb(db, database), authorizedSnapshotLayer)));

    const failed = await Effect.runPromise(program);
    expect(failed).toBeInstanceOf(LeaseExpired);
  });

  test("explicit expirations are clamped to the maximum lease", async () => {
    const now = 1_700_000_000_000;
    const clamped = createLeaseState({ epoch: 1, expiresAt: now + 60_000, now });
    const infinite = createLeaseState({ epoch: 1, expiresAt: Number.POSITIVE_INFINITY, now });
    const past = createLeaseState({ epoch: 1, expiresAt: now - 5, now });
    expect(clamped.expiresAt).toBe(now + MAX_READ_LEASE_MS);
    expect(infinite.expiresAt).toBe(now + MAX_READ_LEASE_MS);
    expect(past.expiresAt).toBe(now - 5);

    const { db } = await setup();
    const raw = await Effect.runPromise(
      Effect.gen(function* () {
        const rawSvc = yield* RawStorageAccess;
        return yield* rawSvc.open({ database, basisT: db.basisT, expiresAt: Date.now() + 60_000 });
      }).pipe(Effect.provide(trustedSnapshotLayer({ open: () => Effect.succeed(db) }))),
    );
    expect(inspectRawSnapshot(raw).expiresAt).toBeLessThanOrEqual(Date.now() + MAX_READ_LEASE_MS);
  });

  test("an invalidated raw snapshot cannot expose storage or mint children", async () => {
    const { db, installed, descriptor } = await setup();
    const program = Effect.gen(function* () {
      const rawSvc = yield* RawStorageAccess;
      const ruleSvc = yield* RuleSnapshotAccess;
      const appSvc = yield* AuthorizedApplicationAccess;
      const raw = yield* rawSvc.open({ database, basisT: db.basisT });
      invalidateRawSnapshot(raw);
      return {
        current: physicalCurrentDb(raw),
        view: physicalViewDb(raw),
        rules: yield* Effect.flip(ruleSvc.project({
          raw,
          installed,
          catalog: descriptor,
          ticket: admit(),
          basisT: db.basisT,
        })),
        auth: yield* Effect.flip(appSvc.open({
          raw,
          ticket: admit(),
          installed,
          catalog,
          catalogVersion: version,
          database,
          applicationBasisT: db.basisT,
          ruleBasisT: db.basisT,
          leaseEpoch: 0,
        })),
      };
    }).pipe(Effect.provide(trustedSnapshotLayer({ open: () => Effect.succeed(db) })));

    const out = await Effect.runPromise(program);
    expect(out.current).toBeUndefined();
    expect(out.view).toBeUndefined();
    expect(out.rules).toBeInstanceOf(SnapshotCancelled);
    expect(out.auth).toBeInstanceOf(SnapshotCancelled);
  });

  test("authorized construction rejects future or mismatched bases", async () => {
    const { db, installed } = await setup();
    const program = Effect.gen(function* () {
      const rawSvc = yield* RawStorageAccess;
      const appSvc = yield* AuthorizedApplicationAccess;
      const raw = yield* rawSvc.open({ database, basisT: db.basisT });
      const future = yield* Effect.flip(appSvc.open({
        raw,
        ticket: admit(),
        installed,
        catalog,
        catalogVersion: version,
        database,
        applicationBasisT: db.basisT + 4,
        ruleBasisT: db.basisT,
        leaseEpoch: 0,
      }));
      const mismatched = yield* Effect.flip(appSvc.open({
        raw,
        ticket: admit(),
        installed,
        catalog,
        catalogVersion: version,
        database,
        applicationBasisT: db.basisT,
        ruleBasisT: db.basisT,
        leaseEpoch: 0,
        asOfT: 1,
      }));
      return { future, mismatched };
    }).pipe(Effect.provide(trustedSnapshotLayer({ open: () => Effect.succeed(db) })));

    const out = await Effect.runPromise(program);
    expect(out.future).toBeInstanceOf(ApplicationSnapshotUnavailable);
    expect(out.mismatched).toBeInstanceOf(ApplicationSnapshotUnavailable);
  });

  test("the raw view collapses to the named application effective t", async () => {
    const { db } = await setup();
    const named = Math.max(0, db.basisT - 1);
    const raw = await Effect.runPromise(
      Effect.gen(function* () {
        const rawSvc = yield* RawStorageAccess;
        return yield* rawSvc.open({ database, basisT: named });
      }).pipe(Effect.provide(trustedSnapshotLayer({ open: () => Effect.succeed(db) }))),
    );
    expect(inspectRawSnapshot(raw)).toMatchObject({ basisT: named, effectiveT: named });
    expect(physicalViewDb(raw)?.effectiveT).toBe(named);
    expect(physicalCurrentDb(raw)?.basisT).toBe(db.basisT);
  });

  test("snapshot identity and principal are frozen copies", async () => {
    const { db, installed, ada, descriptor } = await setup();
    const mutable = {
      subject: "ada",
      claims: { org: "acme", teams: ["eng"] },
      classes: ["member"],
      me: { entity: entity("user"), eid: ada },
    };
    const program = Effect.gen(function* () {
      const rawSvc = yield* RawStorageAccess;
      const ruleSvc = yield* RuleSnapshotAccess;
      const appSvc = yield* AuthorizedApplicationAccess;
      const raw = yield* rawSvc.open({ database, basisT: db.basisT });
      const rules = yield* ruleSvc.project({
        raw,
        installed,
        catalog: descriptor,
        ticket: admit(mutable),
        basisT: db.basisT,
      });
      const auth = yield* appSvc.open({
        raw,
        ticket: admit(mutable),
        installed,
        catalog,
        catalogVersion: version,
        database,
        applicationBasisT: db.basisT,
        ruleBasisT: db.basisT,
        leaseEpoch: 0,
      });
      mutable.me.eid = 999_999;
      mutable.subject = "eve";
      mutable.classes.push("admin");
      const fromMe = yield* ruleSvc.traverseFromMe(rules, [field(userOwner, "authId")]);
      return { raw, auth, fromMe };
    }).pipe(Effect.provide(trustedSnapshotLayer({ open: () => Effect.succeed(db) })));

    const out = await Effect.runPromise(program);
    expect(Object.isFrozen(out.raw)).toBe(true);
    expect(Object.isFrozen(out.auth.principal)).toBe(true);
    expect(out.auth.principal.subject).toBe("ada");
    expect(out.auth.principal.me?.eid).toBe(ada);
    expect(out.auth.principal.classes).toEqual(["member"]);
    expect(out.auth.principal.claims.teams).toEqual(["eng"]);
    expect(() => {
      (out.raw as { database: DatabaseId }).database = DatabaseId.make("other");
    }).toThrow();
    expect(() => {
      (out.auth.principal.claims.teams as string[]).push("ops");
    }).toThrow();
    expect(out.auth.principal.claims.teams).toEqual(["eng"]);
    expect(out.fromMe).toEqual({ _tag: "Present", value: "ada" });
  });

  test("unchecked snapshot factories are not exported", async () => {
    const mod = await import("../../../src/internal/authorization/runtime/snapshots.ts");
    expect("createRawSnapshot" in mod).toBe(false);
    expect("createRuleSnapshot" in mod).toBe(false);
    expect("createAuthorizedSnapshot" in mod).toBe(false);
    expect("ruleProjectionState" in mod).toBe(false);
    expect(typeof mod.mintAuthorizedSnapshot).toBe("function");
    expect(typeof mod.projectLiveRuleField).toBe("function");
  });

  test("traversal hops must belong to the prior ref target", async () => {
    const { conn, installed, ada, issue, descriptor } = await setup();
    const childReport = await conn.transact([
      { ":db/id": "child", ":app.entity.issue/title": "Child", ":app.entity.issue/owner": ada, ":app.entity.issue/parent": issue },
    ]);
    const child = childReport.tempids.child as number;
    const later = conn.db();
    const program = Effect.gen(function* () {
      const rawSvc = yield* RawStorageAccess;
      const ruleSvc = yield* RuleSnapshotAccess;
      const raw = yield* rawSvc.open({ database, basisT: later.basisT });
      const rules = yield* ruleSvc.project({
        raw,
        installed,
        catalog: descriptor,
        ticket: admit({ ...principal, me: { entity: entity("user"), eid: ada } }),
        basisT: later.basisT,
      });
      const ownerThenUser = yield* ruleSvc.traverse(rules, issue, [
        field(issueOwner, "owner"),
        field(userOwner, "authId"),
      ]);
      const ownerThenIssue = yield* Effect.flip(ruleSvc.traverse(rules, issue, [
        field(issueOwner, "owner"),
        field(issueOwner, "title"),
      ]));
      const selfThenTitle = yield* ruleSvc.traverse(rules, child, [
        field(issueOwner, "parent"),
        field(issueOwner, "title"),
      ]);
      const untargeted = yield* Effect.flip(ruleSvc.traverse(rules, issue, [
        field(issueOwner, "link"),
        field(issueOwner, "title"),
      ]));
      const ownerThenTrait = yield* Effect.flip(ruleSvc.traverse(rules, issue, [
        field(issueOwner, "owner"),
        field({ kind: "trait", name: "taggable" }, "tag"),
      ]));
      return { ownerThenUser, ownerThenIssue, selfThenTitle, untargeted, ownerThenTrait };
    }).pipe(Effect.provide(trustedSnapshotLayer({ open: () => Effect.succeed(later) })));

    const out = await Effect.runPromise(program);
    expect(out.ownerThenUser).toEqual({ _tag: "Present", value: "ada" });
    expect(out.selfThenTitle).toEqual({ _tag: "Present", value: "Secret" });
    expect(out.ownerThenIssue).toBeInstanceOf(IncompleteRuleSnapshot);
    expect(out.untargeted).toBeInstanceOf(IncompleteRuleSnapshot);
    expect(out.ownerThenTrait).toBeInstanceOf(IncompleteRuleSnapshot);
    expect((out.ownerThenIssue as IncompleteRuleSnapshot).reason).toEqual(InvalidTraversal);
  });

  test("projection charges the budget for existence and each field datom", async () => {
    const { conn, installed, issue, descriptor } = await setup();
    await conn.transact([{ ":db/id": issue, ":app.entity.issue/labels": ["a", "b", "c"] }]);
    const later = conn.db();
    const program = Effect.gen(function* () {
      const rawSvc = yield* RawStorageAccess;
      const ruleSvc = yield* RuleSnapshotAccess;
      const raw = yield* rawSvc.open({ database, basisT: later.basisT });
      const tight = yield* ruleSvc.project({
        raw,
        installed,
        catalog: descriptor,
        ticket: admit(),
        basisT: later.basisT,
        budgetLimit: 1,
      });
      const scalar = yield* Effect.flip(ruleSvc.lookup(tight, issue, field(issueOwner, "title")));
      const labels = yield* ruleSvc.project({
        raw,
        installed,
        catalog: descriptor,
        ticket: admit(),
        basisT: later.basisT,
        budgetLimit: 3,
      });
      const many = yield* Effect.flip(ruleSvc.lookup(labels, issue, field(issueOwner, "labels")));
      return { scalar, many };
    }).pipe(Effect.provide(trustedSnapshotLayer({ open: () => Effect.succeed(later) })));

    const out = await Effect.runPromise(program);
    expect(out.scalar).toBeInstanceOf(AuthorizationBudgetExceeded);
    expect(out.many).toBeInstanceOf(AuthorizationBudgetExceeded);
  });

  test("rule snapshots require the current storage basis", async () => {
    const { db, installed, descriptor } = await setup();
    const stale = Math.max(0, db.basisT - 1);
    const program = Effect.gen(function* () {
      const rawSvc = yield* RawStorageAccess;
      const ruleSvc = yield* RuleSnapshotAccess;
      const appSvc = yield* AuthorizedApplicationAccess;
      const raw = yield* rawSvc.open({ database, basisT: db.basisT });
      const rules = yield* Effect.flip(ruleSvc.project({
        raw,
        installed,
        catalog: descriptor,
        ticket: admit(),
        basisT: stale,
      }));
      const auth = yield* Effect.flip(appSvc.open({
        raw,
        ticket: admit(),
        installed,
        catalog,
        catalogVersion: version,
        database,
        applicationBasisT: db.basisT,
        ruleBasisT: stale,
      }));
      return { rules, auth };
    }).pipe(Effect.provide(trustedSnapshotLayer({ open: () => Effect.succeed(db) })));

    const out = await Effect.runPromise(program);
    expect(out.rules._tag).toBe("RuleSnapshotUnavailable");
    expect(out.auth).toBeInstanceOf(ApplicationSnapshotUnavailable);
  });
});
