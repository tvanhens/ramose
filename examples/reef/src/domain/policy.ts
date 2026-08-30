import * as Schema from "effect/Schema";
import * as Ramose from "ramose";
import { operations } from "./operations.ts";
import { allShapes } from "./queries.ts";
import { Comment, Issue, Reef, User } from "./schema.ts";

const P = Ramose.Policy;
const { Query } = Ramose;

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
    },
    label: {
      read: true,
    },
    // enddocs:policy-setup
    // docs:policy-issue
    issue: {
      read: true,
      attrs: [

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

export type Class = Ramose.Policy.Class<typeof policy>;

// docs:compiled-policy
export const compiledPolicy = (): string =>
  P.compile(policy, { pulls: allShapes, operations });
// enddocs:compiled-policy
