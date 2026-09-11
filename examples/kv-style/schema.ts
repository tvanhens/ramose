import * as S from "effect/Schema";
import * as Ramose from "ramose/db";

export const User = Ramose.Entity("user", {
  name: Ramose.Field.unique(Ramose.string(), "upsert"),
}, {
  operations: (Operation) => ({
    create: Operation({
      self: false,
      input: S.Struct({ name: S.String }),
      output: S.Struct({ id: Ramose.EntityId }),
      run(op, { name }) {
        return { id: op.create({ name }) };
      },
    }),
  }),
});
export const Movies = Ramose.Schema("kv-style", { user: User });

Movies.applyPolicy(({ policy }) => {
  policy.user.read.always();
});
