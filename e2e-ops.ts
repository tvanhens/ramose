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

const ReefUser = Ramose.Entity("user", {
  name: Ramose.string(),
});
const ReefIssue = Ramose.Entity("issue", {
  title: Ramose.string(),
  status: Ramose.string(),
  rank: Ramose.float(),
  creator: Ramose.Ref(ReefUser),
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

export const addReefUser = Ramose.Operation(
  "e2e/add-reef-user",
  {
    input: Schema.Struct({ name: Schema.String }),
    output: Schema.Struct({}),
  },
  (op, input) => {
    op.put(ReefUser, { name: input.name });
    return {};
  },
);

export const addReefIssue = Ramose.Operation(
  "e2e/add-reef-issue",
  {
    input: Schema.Struct({
      title: Schema.String,
      status: Schema.String,
      rank: Schema.Number,
      creatorId: Schema.Number,
    }),
    output: Schema.Struct({}),
  },
  (op, input) => {
    op.put(ReefIssue, {
      title: input.title,
      status: input.status,
      rank: input.rank,
      creator: input.creatorId,
    });
    return {};
  },
);

export const moveReefIssue = Ramose.Operation.patch(
  "e2e/move-reef-issue",
  ReefIssue,
  ["status", "rank"],
);

export const operations = Ramose.Operations({
  addSession,
  addReefUser,
  addReefIssue,
  moveReefIssue,
});
