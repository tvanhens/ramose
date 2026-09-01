import * as Effect from "effect/Effect";
import * as EffectSchema from "effect/Schema";
import * as Result from "effect/Result";
import {
  Entity,
  EntityId,
  Field,
  Ref,
  Schema,
  string,
} from "ramose/db";
import {
  assembleCatalogDefinitions,
  DigestHex,
  hashReadCompatibility,
} from "../../packages/ramose/src/internal/authorization/index.ts";

export const CONFORMANCE_DATABASES = Object.freeze([
  "conformance-world-a",
  "conformance-world-b",
  "conformance-history-a",
  "conformance-history-b",
  "conformance-live",
  "conformance-expiry",
  "conformance-idempotent-revocation",
  "conformance-idempotent-self-delete",
  "conformance-idempotent-self-hidden",
  "conformance-idempotent-lookup-rebind",
  "conformance-replication-snapshot",
  "conformance-replication-resume",
  "conformance-replication-interrupt",
  "conformance-replication-noninterference",
  "conformance-replication-retention-zero",
  "conformance-replication-retention-pressure",
  "conformance-replication-watch-failure",
  "conformance-replication-resume-ready",
  "conformance-replication-compatibility",
  "conformance-replication-identity-root",
  "conformance-replication-entity-handles",
  "conformance-replication-inert-change",
  "conformance-replication-hidden-scale",
  "conformance-replication-cold-isolate",
  "conformance-replication-multi-device",
  "conformance-replication-commit-wake",
  "conformance-replication-hidden-wake",
  "conformance-replication-wake-burst",
  "conformance-replication-scope-armed",
  "conformance-replication-scope-bystander",
  "conformance-replication-keepalive",
]);

export const ConformanceUser = Entity("conformanceUser", {
  sub: Field.unique(string(), "strict"),
  access: string({ default: () => "enabled" }),
}, {
  operations: (Operation) => ({
    create: Operation({
      self: false,
      input: EffectSchema.Struct({ sub: EffectSchema.String }),
      output: EffectSchema.Struct({ id: EntityId }),
      run(op, input) {
        return { id: op.create({ sub: input.sub }) };
      },
    }),
    setAccess: Operation({
      input: EffectSchema.Struct({ access: EffectSchema.String }),
      output: EffectSchema.Struct({ id: EntityId }),
      run(op, input) {
        op.self.set(ConformanceUser.access, input.access);
        return { id: op.self };
      },
    }),
  }),
});

export const ConformanceIssue = Entity("conformanceIssue", {
  key: Field.unique(string(), "strict"),
  title: string(),
  owner: Ref(ConformanceUser),
  org: string(),
  parent: Field(Ref.self, { optional: true }),
  audit: string({ optional: true }),
}, {
  operations: (Operation) => ({
    create: Operation({
      self: false,
      input: EffectSchema.Struct({
        key: EffectSchema.String,
        title: EffectSchema.String,
        owner: EntityId,
        org: EffectSchema.String,
        parent: EffectSchema.optionalKey(EntityId),
        audit: EffectSchema.optionalKey(EffectSchema.String),
      }),
      output: EffectSchema.Struct({ id: EntityId }),
      run(op, input) {
        return {
          id: op.create({
            key: input.key,
            title: input.title,
            owner: input.owner as never,
            org: input.org,
            ...(input.parent === undefined
              ? {}
              : { parent: input.parent as never }),
            ...(input.audit === undefined ? {} : { audit: input.audit }),
          }),
        };
      },
    }),
    rename: Operation({
      input: EffectSchema.Struct({ title: EffectSchema.String }),
      output: EffectSchema.Struct({ id: EntityId, title: EffectSchema.String }),
      run(op, input) {
        op.self.set(ConformanceIssue.title, input.title);
        return { id: op.self, title: input.title };
      },
    }),
    deleteAndEchoTitle: Operation({
      input: EffectSchema.Struct({}),
      output: EffectSchema.Struct({ title: EffectSchema.String }),
      async run(op) {
        const row = await op.pull(op.self.eid, [":conformanceIssue/title"]) as Record<string, unknown>;
        op.self.delete();
        return { title: row[":conformanceIssue/title"] as string };
      },
    }),
    archive: Operation({
      input: EffectSchema.Struct({
        key: EffectSchema.String,
        owner: EntityId,
        org: EffectSchema.String,
      }),
      output: EffectSchema.Struct({ id: EntityId }),
      run(op, input) {
        op.self.set(ConformanceIssue.key, input.key);
        op.self.set(ConformanceIssue.owner, input.owner as never);
        op.self.set(ConformanceIssue.org, input.org);
        return { id: op.self };
      },
    }),
    transfer: Operation({
      input: EffectSchema.Struct({
        owner: EntityId,
        org: EffectSchema.String,
      }),
      output: EffectSchema.Struct({ id: EntityId }),
      run(op, input) {
        op.self.set(ConformanceIssue.owner, input.owner as never);
        op.self.set(ConformanceIssue.org, input.org);
        return { id: op.self };
      },
    }),
    moveLookup: Operation({
      input: EffectSchema.Struct({
        replacement: EntityId,
        archivedKey: EffectSchema.String,
        lookupKey: EffectSchema.String,
      }),
      output: EffectSchema.Struct({ id: EntityId }),
      run(op, input) {
        op.self.set(ConformanceIssue.key, input.archivedKey);
        op.set(
          ConformanceIssue,
          input.replacement,
          ConformanceIssue.key,
          input.lookupKey,
        );
        return { id: op.self };
      },
    }),
  }),
});

export const ConformanceSchema = Schema("local-conformance", {
  conformanceUser: ConformanceUser,
  conformanceIssue: ConformanceIssue,
});

const organizationClaim = {
  key: "org",
  optional: false,
  shape: { _tag: "scalar" as const, valueType: "string" as const },
} as const;

ConformanceSchema.applyPolicy(
  {
    principal: ConformanceUser.sub,
    roles: ["member", "admin"] as const,
    claims: [organizationClaim] as const,
  },
  ({ policy, actor, session, allOf }) => {
    const member = session.roles.member;
    const admin = session.roles.admin;

    policy.conformanceUser.read.where(admin);
    policy.conformanceUser.read.where((user) => user.sub.eq(session.subject));

    policy.conformanceIssue.read.where(admin);
    policy.conformanceIssue.read.where((issue) =>
      allOf(issue.owner.access.eq("enabled"), issue.owner.eq(actor))
    );
    policy.conformanceIssue.read.where((issue) => issue.org.eq(session.claims.org));
    policy.conformanceIssue.fields.audit.read.where(admin);

    policy.conformanceUser.operations.create.where(admin);
    policy.conformanceUser.operations.setAccess.where(admin);
    policy.conformanceIssue.operations.create.where(admin);

    policy.conformanceIssue.operations.rename.where(member);
    policy.conformanceIssue.operations.rename.where(admin);
    policy.conformanceIssue.operations.deleteAndEchoTitle.where(member);
    policy.conformanceIssue.operations.deleteAndEchoTitle.where(admin);
    policy.conformanceIssue.operations.archive.where(member);
    policy.conformanceIssue.operations.archive.where(admin);
    policy.conformanceIssue.operations.transfer.where(member);
    policy.conformanceIssue.operations.transfer.where(admin);
    policy.conformanceIssue.operations.moveLookup.where(member);
    policy.conformanceIssue.operations.moveLookup.where(admin);
  },
);

export const conformanceCatalogDeployment = Object.freeze({
  root: ConformanceSchema,
  deployments: CONFORMANCE_DATABASES.map((database) => ({ database })),
});

const compatibilityDefinitions = await Effect.runPromise(assembleCatalogDefinitions({
  root: ConformanceSchema,
  artifactHash: DigestHex.make("0".repeat(64)),
}));
const compatibilityUnit = Result.getOrThrow(
  compatibilityDefinitions.require(compatibilityDefinitions.root),
);
export const conformanceReadCompatibilityHash = await Effect.runPromise(
  hashReadCompatibility(compatibilityUnit.unit.catalog),
);

const deployedCatalog = compatibilityUnit.unit.catalog;

export const conformanceInertReadCompatibilityHash = await Effect.runPromise(
  hashReadCompatibility({
    entities: deployedCatalog.entities.map((entity) => ({
      ...entity,
      doc: `documented ${entity.id.name}`,
    })),
    traits: deployedCatalog.traits.map((trait) => ({
      ...trait,
      doc: `documented ${trait.id.name}`,
    })),
    fields: deployedCatalog.fields.map((field) => ({
      ...field,
      doc: `documented ${field.id.localName}`,
    })),
    traitComposition: deployedCatalog.traitComposition,
  }),
);

export const conformanceRotatedReadCompatibilityHash = await Effect.runPromise(
  hashReadCompatibility({
    entities: deployedCatalog.entities,
    traits: deployedCatalog.traits,
    fields: deployedCatalog.fields.map((field, position) =>
      position === 0 ? { ...field, index: !field.index } : field
    ),
    traitComposition: deployedCatalog.traitComposition,
  }),
);
