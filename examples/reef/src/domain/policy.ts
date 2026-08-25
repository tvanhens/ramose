/**
 * The workspace policy (https://ramose.ai/reference/policy/): rules are
 * query fragments over catalog attributes, compiled at deploy into the peer
 * Worker's env. One policy serves every workspace — the JWT's `ramose.db`
 * binds a token to one of them.
 *
 * Classes (carried as `ramose.class`, minted from the Better Auth org role):
 *
 *   owner   workspace owners/admins — may install schema (`schemaClasses`)
 *           and read `issue.privateNote`. Still subject to the rules.
 *   member  can create issues/comments and edit or delete *their own*
 *   viewer  read-only; every write arm denies it
 *
 * There is no bypass class. `schemaClasses: ["owner"]` is what lets the
 * creator run `db.install()` from a browser JWT; a `superuser` class
 * would skip every rule and must not be minted to a browser.
 *
 * Deny is the default: a namespace without a rule denies, and `preset`
 * attributes are peer-owned on create — a client-supplied value is allowed
 * only when identical, so a member can never forge `issue.creator`.
 */

import * as Schema from "effect/Schema";
import * as Ramose from "ramose";
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
      create: P.class("owner", "member"),
    },
    // enddocs:policy-setup
    // docs:policy-issue
    issue: {
      read: true,
      create: P.class("owner", "member"),
      set: { class: ["owner", "member"], rule: ownIssue },
      remove: { class: ["owner", "member"], rule: ownIssue },
      delete: { class: ["owner", "member"], rule: ownIssue },
      // docs:policy-preset
      preset: [P.preset(Issue.creator, P.principal)],
      // enddocs:policy-preset
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
      create: P.class("owner", "member"),
      remove: { class: ["owner", "member"], rule: ownComment },
      delete: { class: ["owner", "member"], rule: ownComment },
      preset: [P.preset(Comment.author, P.principal)],
    },
    // enddocs:policy-comment
  },
);
// enddocs:policy

/** Derived from the policy value — Reef does not maintain a parallel tuple. */
export type Class = Ramose.Policy.Class<typeof policy>;

/**
 * The wire JSON for `RAMOSE_POLICY`. Compiling against the app's pull shapes
 * makes "a masked attribute pulled as required" a deploy-time error.
 */
// docs:compiled-policy
export const compiledPolicy = (): string =>
  P.compile(policy, { pulls: allShapes });
// enddocs:compiled-policy
