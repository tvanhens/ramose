/**
 * The workspace policy (https://ramose.ai/reference/policy/): rules are
 * query fragments over catalog attributes, compiled at deploy into the peer
 * Worker's env. One policy serves every workspace — the JWT's `ramose.db`
 * binds a token to one of them.
 *
 * Classes (carried as `ramose.class`, minted from the Better Auth org role):
 *
 *   admin   workspace owners/admins — bypasses every rule (core `isAdmin`),
 *           which is also what lets the creator run `db.install()` and read
 *           `issue.privateNote`
 *   member  can create issues/comments and edit or delete *their own*
 *   viewer  read-only; every write arm denies it
 *
 * Deny is the default: a namespace without a rule denies, and `preset`
 * attributes are peer-owned on create — a client-supplied value is allowed
 * only when identical, so a member can never forge `issue.creator`.
 */

import * as Schema from "effect/Schema";
import * as Ramose from "ramose";
import { allShapes } from "./queries.ts";
import { Comment, Issue, Reef, User } from "./schema.ts";
import { CLASSES } from "./shared.ts";

const P = Ramose.Policy;
const { Query } = Ramose;

/** `member` may touch an issue they created; `admin` never reaches the rules. */
const ownIssue = (me: Ramose.Policy.Me<typeof User>) => Query.is(Issue.creator, me);
const ownComment = (me: Ramose.Policy.Me<typeof User>) => Query.is(Comment.author, me);

export const policy = Ramose.policy(
  {
    catalog: Reef,
    principal: User.sub,
    classes: CLASSES,
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
      create: P.class("member"),
    },
    issue: {
      read: true,
      create: P.class("member"),
      add: { class: "member", rule: ownIssue },
      retract: { class: "member", rule: ownIssue },
      retractEntity: { class: "member", rule: ownIssue },
      preset: [P.preset(Issue.creator, P.principal)],
      attrs: [
        // Narrows the namespace `read`: members and viewers never see this
        // datom — pulls must ask for it as `.optional` (compile() checks).
        P.attr(Issue.privateNote, { read: P.class("admin") }),
      ],
    },
    comment: {
      read: true,
      create: P.class("member"),
      retract: { class: "member", rule: ownComment },
      retractEntity: { class: "member", rule: ownComment },
      preset: [P.preset(Comment.author, P.principal)],
    },
  },
);

/**
 * The wire JSON for `RAMOSE_POLICY`. Compiling against the app's pull shapes
 * makes "a masked attribute pulled as required" a deploy-time error.
 */
export const compiledPolicy = (): string =>
  P.compile(policy, { pulls: allShapes });
