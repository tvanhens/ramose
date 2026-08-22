/**
 * The workspace policy (https://ramose.ai/reference/policy/): rules over catalog attributes and
 * JWT claims, compiled at deploy into the peer Worker's env. One policy serves
 * every workspace — the JWT's `ramose.db` binds a token to one of them.
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

import * as Ramose from "ramose";
import { allShapes } from "./queries.ts";
import { Comment, Issue, Reef, User } from "./schema.ts";
import { CLASSES } from "./shared.ts";

const P = Ramose.Policy;

const anyone = P.or(P.class("admin"), P.class("member"), P.class("viewer"));
const editor = P.or(P.class("admin"), P.class("member"));
const admin = P.class("admin");

/** `member` may touch an issue they created; `admin` never reaches the rules. */
const ownIssue = P.and(P.class("member"), P.eq(Issue.creator, P.principal));
const ownComment = P.and(P.class("member"), P.eq(Comment.author, P.principal));

export const policy = P.policy(Reef, {
  principal: User.sub,
  classes: CLASSES,
  ns: {
    user: {
      read: P.allow(anyone),
      // First entry into a workspace writes your own row; `sub` is preset from
      // the token, so you cannot register as someone else.
      create: P.allow(editor),
      preset: [P.preset(User.sub, P.claims.sub)],
    },
    label: {
      read: P.allow(anyone),
      create: P.allow(editor),
    },
    issue: {
      read: P.allow(anyone),
      create: P.allow(editor),
      add: P.allow(ownIssue),
      retract: P.allow(ownIssue),
      retractEntity: P.allow(ownIssue),
      preset: [P.preset(Issue.creator, P.principal)],
      attrs: [
        // Narrows the namespace `read`: members and viewers never see this
        // datom — pulls must ask for it as `.optional` (compile() checks).
        P.attr(Issue.privateNote, { read: P.allow(admin) }),
      ],
    },
    comment: {
      read: P.allow(anyone),
      create: P.allow(editor),
      retract: P.allow(ownComment),
      retractEntity: P.allow(ownComment),
      preset: [P.preset(Comment.author, P.principal)],
    },
  },
});

/**
 * The wire JSON for `RAMOSE_POLICY`. Compiling against the app's pull shapes
 * makes "a masked attribute pulled as required" a deploy-time error.
 */
export const compiledPolicy = (): string =>
  P.compile(policy, { pulls: allShapes });
