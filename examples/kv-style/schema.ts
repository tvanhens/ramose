import * as Ramose from "ramose/db";

export const User = Ramose.Entity("user", {
  name: Ramose.Field.unique(Ramose.string(), "upsert"),
});
export const Movies = Ramose.Schema("kv-style", { user: User });

Movies.applyPolicy(({ policy }) => {
  policy.user.read.always();
});
