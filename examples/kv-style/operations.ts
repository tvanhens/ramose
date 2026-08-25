import * as Schema from "effect/Schema";
import * as Ramose from "ramose/db";
import { Movies, User } from "./schema.ts";

export const addUser = Ramose.Operation(
  "user/add",
  {
    input: Schema.Struct({ name: Schema.String }),
    output: Schema.Struct({}),
    schema: Movies,
    doc: "Create a user by name",
  },
  (op, input) => {
    op.put(User, { name: input.name });
    return {};
  },
);

export const operations = Ramose.defineOperations(Movies, { addUser });
