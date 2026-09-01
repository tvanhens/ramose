import * as EffectSchema from "effect/Schema";
import { Entity, EntityId, Field, Schema, string } from "ramose/db";

export const BENCH_DATABASE = "bench-ops";

export const BenchUser = Entity("benchUser", {
  sub: Field.unique(string(), "strict"),
});

export const BenchItem = Entity("benchItem", {
  key: Field.unique(string(), "strict"),
  value: string(),
}, {
  operations: (Operation) => ({
    create: Operation({
      self: false,
      input: EffectSchema.Struct({
        key: EffectSchema.String,
        value: EffectSchema.String,
      }),
      output: EffectSchema.Struct({ id: EntityId }),
      run(op, input) {
        return { id: op.create({ key: input.key, value: input.value }) };
      },
    }),
  }),
});

export const BenchSchema = Schema("bench-cloudflare", {
  benchUser: BenchUser,
  benchItem: BenchItem,
});

BenchSchema.applyPolicy(
  {
    principal: BenchUser.sub,
    roles: ["writer"] as const,
  },
  ({ policy, session }) => {
    const writer = session.roles.writer;
    policy.benchUser.read.where(writer);
    policy.benchItem.read.where(writer);
    policy.benchItem.operations.create.where(writer);
  },
);

export const benchCatalogDeployment = Object.freeze({
  root: BenchSchema,
  deployments: [{ database: BENCH_DATABASE }],
});
