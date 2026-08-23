/**
 * The one-method client: a database is a name. Shared by `connect` and
 * the `ramose/db/effect` hatch so neither deep-imports the other.
 *
 * Type-only — this file must not import `effect`.
 */

import type { Db } from "./Db.ts";
import type { AnySchema } from "./Schema.ts";

export interface DatabasesShape {
  db<C extends AnySchema>(name: string, schema: C): Db<C>;
}
