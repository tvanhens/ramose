/**
 * The leaf catalog — what one workspace graph runs. Compare Reef's
 * `examples/reef/src/domain/schema.ts` + `policy.ts` + `app/mutations.ts`:
 * the same concepts land here in one file because a catalog is one value
 * (schema + policy under a permanent key) and defaults absorb the
 * who-did-this boilerplate.
 *
 * Nobody installs this: a workspace exists because an org graph holds a `Ws`
 * row composing `Graph(workspaceCatalog)` (see org.ts). Storage provisions
 * lazily on first entry.
 */

import { Schema } from "ramose/effect";
import * as Ramose from "./future.ts";
import { Q } from "./future.ts";
import { addTagOp, removeTagOp, Taggable } from "./taggable.ts";

// ── schema ───────────────────────────────────────────────────────────────────

/** One row per principal who has entered this workspace. */
export const User = Ramose.Entity("user", {
  sub: Ramose.string({ unique: "upsert" }),
  name: Ramose.string({ optional: true }),
});

export const Issue = Ramose.Entity(
  "issue",
  {
    title: Ramose.string(),
    status: Ramose.Enum(["todo", "doing", "done"]),
    // Field defaults (#313 rule 8): values computed at creation when the
    // caller supplies none. This is what deletes `createdAt: new Date(),
    // creator: op.principal` from every create body below.
    createdAt: Ramose.timestamp({ default: ({ now }) => now }),
    creator: Ramose.Ref(User, { default: ({ me }) => me }),
    /** Visible only through the `mine` rule — see the policy's field arm. */
    privateNote: Ramose.string({ optional: true }),
  },
  { with: [Taggable] }, // Issue.tags is :taggable/tags — same ident as Ws.tags in org.ts
);

export const Workspace = Ramose.Schema({ user: User, issue: Issue });

// ── operations ───────────────────────────────────────────────────────────────

const Op = Ramose.Operation;

/**
 * Reef's createIssueOp is ~18 lines of body; defaults reduce this one to the
 * caller's actual intent. `status` could default too ("todo") — but that's an
 * app constant, not a context value, and the `default: () => "todo"` spelling
 * feels heavier than just writing it here. ergonomics: should defaults take
 * plain values as well as functions?
 */
export const createIssueOp = Op(
  "issue/create",
  {
    input: Schema.Struct({ title: Schema.String }),
    doc: "Create an issue",
  },
  (op, input) => {
    op.put(Issue, { title: input.title, status: "todo" });
  },
);

export const moveIssueOp = Op.patch("issue/move", Issue, ["status"], {
  doc: "Move an issue between columns",
});

export const setPrivateNoteOp = Op.patch(
  "issue/set-private-note",
  Issue,
  ["privateNote"],
  { doc: "Set the creator-only note" },
);

// Note what is NOT here: no provisionWorkspaceOp, no db/install effect, no
// org/register call-out (compare Reef's mutations.ts). Creating the graph is
// the parent's one-transaction createWsOp; this catalog only ever runs inside
// an already-existing workspace. Also absent: any op writing `createdAt` or
// `creator` after creation — operations being the only write path makes them
// immutable with no extra rule (#312's `:graph/catalog` argument, applied to
// app fields).

export const operations = Ramose.defineOperations(Workspace, {
  createIssueOp,
  moveIssueOp,
  setPrivateNoteOp,
  addTagOp,
  removeTagOp,
});

// ── policy ───────────────────────────────────────────────────────────────────

/**
 * The app's vocabulary: plain functions, reused across arms. Written in the
 * implicit-row shape (the fragment is rooted at the row being decided —
 * today's `rule:` style). org.ts writes its vocabulary in #312's explicit
 * `(row) =>` shape; the README tallies which reads better where.
 */
const mine: Ramose.Rule = ({ me }) => Q.is(Issue.creator, me);

export const workspacePolicy = Ramose.policy(
  { schema: Workspace, principal: User.sub, operations },
  {
    user: { read: true },
    issue: {
      read: true,
      fields: { privateNote: mine },
    },
    operations: {
      // `true` is not "public": entry already ran the org's enter function.
      // Inside a graph, "anyone" means "anyone the parent let in".
      createIssueOp: true,
      moveIssueOp: mine,
      setPrivateNoteOp: mine,
      addTagOp: true,
      removeTagOp: true,
    },
  },
);

// ── the catalog ──────────────────────────────────────────────────────────────

/**
 * "workspace" is a permanent name: every Ws row is stamped
 * `:graph/catalog = "workspace"` at creation, and the registry resolves it
 * back to this value at boot. Rename never.
 *
 * ergonomics: the schema is threaded three times on this page — into
 * `defineOperations`, into `policy`, and into `Catalog`. The policy already
 * holds schema + operations; the catalog holds schema + policy. One of these
 * should imply the others (`Catalog("workspace", { policy })`?), or the
 * catalog should be the thing that takes all three flat.
 */
export const workspaceCatalog = Ramose.Catalog("workspace", {
  schema: Workspace,
  policy: workspacePolicy,
});
