/**
 * The catalog, on the portable entry: `ramose/db` runs in a browser,
 * a Worker, Node/Bun and a test, so the same `schema.ts` is shared by the
 * stack, the app Worker and any client.
 */

import * as Ramose from "ramose/db";
import * as Schema from "effect/Schema";

export const User = Ramose.Entity("user", {
  name: Ramose.Field(Schema.String, { unique: "upsert" }),
});
export const Movies = Ramose.Schema({ user: User });
