/**
 * The workspace policy (https://ramose.ai/reference/policy/): rules are
 * query fragments over catalog attributes, compiled at deploy into the peer
 * Worker's env. One policy serves every workspace — the JWT's `ramose.db`
 * binds a token to one of them.
 *
 * Reads are per-datom masks. Writes are per-operation arms (deny-by-default).
 *
 * Classes (carried as `ramose.class`, minted from the Better Auth org role):
 *
 *   owner   workspace owners/admins — may install schema (`schemaClasses`)
 *           and read `issue.privateNote`. Still subject to the rules.
 *   member  can run the issue/comment operations on *their own* rows
 *   viewer  read-only; every operation arm denies it
 *
 * There is no bypass class. `schemaClasses: ["owner"]` is what lets the
 * creator run `db.install()` from a browser JWT; a `superuser` class
 * would skip every rule and must not be minted to a browser.
 *
 * Deny is the default: a namespace without a read arm hides every datom,
 * and a registered operation without an arm denies everyone but superuser.
 * Who-did-this fields (`issue.creator`, `comment.author`) are written from
 * `op.principal` in the operation body — the client never sends them.
 */

import * as Schema from "effect/Schema";
import * as Ramose from "ramose";
import { operations } from "./operations.ts";
import { allShapes } from "./queries.ts";
import { Comment, Issue, Reef, User } from "./schema.ts";

const P = Ramose.Policy;
const { Query } = Ramose;

/** `member` may touch an issue they created; `owner` reaches the same rules. */
// docs:own-rules
const ownIssue = (me: Ramose.Policy.Me<typeof User>) => Query.is(Issue.creator, me);
const ownComment = (me: Ramose.Policy.Me<typeof User>) => Query.is(Comment.author, me);
// enddocs:own-rules

// docs:policy
// docs:policy-setup
export const policy = Ramose.policy(
  {
    schema: Reef,
    principal: User.sub,
    classes: ["owner", "member", "viewer"],
    schemaClasses: ["owner"],
    operations,
    claims: Schema.Struct({
      name: Schema.optional(Schema.String),
      email: Schema.optional(Schema.String),
    }),
  },
  {
    user: {
      read: true,
      // The peer upserts `sub`, `role`, and `ramose.attrs` (name, email).
      // Clients never write this row.
    },
    label: {
      read: true,
    },
    // enddocs:policy-setup
    // docs:policy-issue
    issue: {
      read: true,
      attrs: [
        // Narrows the namespace `read`: members and viewers never see this
        // datom — pulls must ask for it as `.optional` (compile() checks).
        // docs:policy-private-note
        P.field(Issue.privateNote, { read: P.class("owner") }),
        // enddocs:policy-private-note
      ],
    },
    // enddocs:policy-issue
    // docs:policy-comment
    comment: {
      read: true,
    },
    // enddocs:policy-comment
    // addCommentOp is class-only: its `on` is the issue, so ownIssue would
    // limit comments to the issue creator (the old comment.create arm did not).
    // docs:policy-operations
    operations: {
      provisionWorkspaceOp: P.class("owner"),
      createIssueOp: P.class("owner", "member"),
      seedSampleIssuesOp: P.class("owner", "member"),
      moveIssueOp: { class: ["owner", "member"], rule: ownIssue },
      setStatusOp: { class: ["owner", "member"], rule: ownIssue },
      addCommentOp: P.class("owner", "member"),
      deleteIssueOp: { class: ["owner", "member"], rule: ownIssue },
      setTitleOp: { class: ["owner", "member"], rule: ownIssue },
      setDescriptionOp: { class: ["owner", "member"], rule: ownIssue },
      setPriorityOp: { class: ["owner", "member"], rule: ownIssue },
      setAssigneeOp: { class: ["owner", "member"], rule: ownIssue },
      toggleLabelOp: { class: ["owner", "member"], rule: ownIssue },
      setPrivateNoteOp: P.class("owner"),
      deleteCommentOp: { class: ["owner", "member"], rule: ownComment },
    },
    // enddocs:policy-operations
  },
);
// enddocs:policy

/** Derived from the policy value — Reef does not maintain a parallel tuple. */
export type Class = Ramose.Policy.Class<typeof policy>;

/**
 * The wire JSON for `RAMOSE_POLICY`. Compiling against the app's pull shapes
 * and operations registry makes a masked required pull, or an armed name
 * that is not registered, a deploy-time error.
 */
// docs:compiled-policy
export const compiledPolicy = (): string =>
  P.compile(policy, { pulls: allShapes, operations });
// enddocs:compiled-policy
