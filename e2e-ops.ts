/**
 * Operations registered on the root e2e peer (`e2e-peer.ts`). The public
 * promise-surface e2e test writes through `db.run`; the default
 * `createServer()` has an empty registry and would 400 unknown operations.
 */
import * as Schema from "effect/Schema";
import * as Ramose from "ramose/db";

const Session = Ramose.Entity("s", {
  name: Ramose.string({ unique: "upsert" }),
  n: Ramose.int(),
});

export const addSession = Ramose.Operation(
  "e2e/add-session",
  {
    input: Schema.Struct({ name: Schema.String, n: Schema.Number }),
    output: Schema.Struct({}),
  },
  (op, input) => {
    const e = op.entity();
    e.set(Session.name, input.name);
    e.set(Session.n, input.n);
    return {};
  },
);

export const operations = Ramose.Operations({ addSession });
