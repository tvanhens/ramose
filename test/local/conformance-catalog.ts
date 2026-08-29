/** Deployed catalog for the real-stack filtered-Db conformance gate. */

import * as Effect from "effect/Effect";
import * as EffectSchema from "effect/Schema";
import { Catalog, Policy } from "ramose";
import {
  Entity,
  EntityId,
  Field,
  OwnedOperations,
  Ref,
  Schema,
  string,
} from "ramose/db";

export const CONFORMANCE_DATABASES = Object.freeze([
  "conformance-world-a",
  "conformance-world-b",
  "conformance-history-a",
  "conformance-history-b",
  "conformance-live",
  "conformance-expiry",
  "conformance-idempotent-revocation",
]);

export const ConformanceUser = Entity("conformanceUser", {
  sub: Field.unique(string(), "strict"),
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
  }),
});

export const ConformanceSchema = Schema({
  conformanceUser: ConformanceUser,
  conformanceIssue: ConformanceIssue,
});

const member = Policy.hasClass("member");
const admin = Policy.hasClass("admin");

const policy = await Effect.runPromise(Policy.compileReadAuthorization({
  schema: ConformanceSchema,
  classes: ["member", "admin"],
  claims: [{
    key: "org",
    optional: false,
    shape: { _tag: "scalar", valueType: "string" },
  }],
  principal: { entity: ConformanceUser.sub },
  rules: [
    Policy.read(ConformanceUser).when(
      Policy.any(admin, Policy.eq(ConformanceUser.sub, Policy.subject)),
    ),
    Policy.read(ConformanceIssue).when(
      Policy.any(
        admin,
        Policy.eq(ConformanceIssue.owner, Policy.me),
        Policy.eq(ConformanceIssue.org, Policy.claim("org")),
      ),
    ),
    Policy.read(ConformanceIssue.audit).when(admin),
    Policy.invoke(ConformanceUser[OwnedOperations].create).when(admin),
    Policy.invoke(ConformanceIssue[OwnedOperations].create).when(admin),
    Policy.invoke(ConformanceIssue[OwnedOperations].rename).when(
      Policy.any(member, admin),
    ),
    Policy.invoke(ConformanceIssue[OwnedOperations].transfer).when(
      Policy.any(member, admin),
    ),
  ],
}));

export const conformanceCatalog = Catalog("local-conformance", {
  schema: ConformanceSchema,
  policy,
});

export const conformanceCatalogDeployment = Object.freeze({
  root: conformanceCatalog,
  deployments: CONFORMANCE_DATABASES.map((database) => ({ database })),
});
