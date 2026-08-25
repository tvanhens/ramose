/**
 * The root catalog — the org graph every credential lands in first. Its `Ws`
 * rows ARE the workspaces (#312 model statement 2): composing
 * `Graph(workspaceCatalog)` declares that each row is an enterable child
 * graph running the workspace catalog.
 *
 * Imports point down the tree (org imports workspace), which works because
 * this tree is finite. A self-similar schema — folders holding folders — hits
 * definition-order: the catalog isn't constructed yet when its own schema
 * composes it. That's what the thunk form is for:
 *
 *   const Folder = Ramose.Entity("folder", {}, {
 *     with: [Ramose.Graph(() => folderCatalog)],   // lazy: same catalog, one level down
 *   });
 *
 * ergonomics: if the recursive case needs the thunk anyway, should `Graph()`
 * take *only* thunks, so there's one spelling? See README §self-nesting.
 */

import { Schema } from "ramose/effect";
import * as Ramose from "./future.ts";
import { Q } from "./future.ts";
import { addTagOp, removeTagOp, Taggable } from "./taggable.ts";
import { workspaceCatalog } from "./workspace.ts";

// ── schema ───────────────────────────────────────────────────────────────────

export const User = Ramose.Entity("user", {
  sub: Ramose.string({ unique: "upsert" }),
  name: Ramose.string({ optional: true }),
});

/**
 * No own fields: `name`, `doc`, and the catalog stamp all come from the Graph
 * trait (shared idents — `:graph/name` is the same attribute on every
 * graph-composing kind, so sibling-name uniqueness is one constraint across
 * kinds). Taggable rides along to show one app trait composed in two
 * catalogs: `Ws.tags` and workspace's `Issue.tags` are the same ident.
 */
export const Ws = Ramose.Entity("ws", {}, {
  with: [Ramose.Graph(workspaceCatalog), Taggable],
});

/** Roles are app data, not an engine concept (#312: "there are no roles"). */
export const Membership = Ramose.Entity("membership", {
  user: Ramose.Ref(User),
  ws: Ramose.Ref(Ws),
  role: Ramose.Enum(["owner", "member"]),
});

/**
 * An agent credential is a row (#312 §Agents). The ApiKey trait carries
 * `:api-key/hash` and `:api-key/sub`; the engine resolves bearer `rk_` keys
 * through the shared ident. Retract the row to revoke — audit is `history`.
 */
export const AgentKey = Ramose.Entity(
  "agent-key",
  { doc: Ramose.string() },
  { with: [Ramose.ApiKey] },
);

export const Org = Ramose.Schema({
  user: User,
  ws: Ws,
  membership: Membership,
  agentKey: AgentKey,
});

// ── vocabulary ───────────────────────────────────────────────────────────────

/**
 * Written in #312's explicit-row shape — `(auth) => (row) => Fragment` — since
 * these walk from the decided row (`ws`) through a reverse ref. Contrast
 * workspace.ts's `mine`, which stays implicit. Living with both: the explicit
 * row variable earns its keep only when the fragment mentions the row more
 * than once (it never does here — the trailing `(ws)` application is pure
 * ceremony). Worse, the two shapes fight in the type system: a fragment is
 * itself applicable, so "returns a fragment or returns a row-lambda" gives
 * the inner parameter two candidate contextual types and `ws` degrades to
 * `any` without the annotation below. README §rules proposes collapsing them.
 */
const memberOf: Ramose.Rule = ({ claim }) => (ws: Ramose.RowVar) =>
  Q.some(
    Membership.ws.reverse, // the memberships pointing at this ws
    Q.is(Membership.user, [User.sub, claim.sub]),
  )(ws);

const ownerOf: Ramose.Rule = ({ claim }) => (ws: Ramose.RowVar) =>
  Q.some(
    Membership.ws.reverse,
    Q.and(
      Q.is(Membership.user, [User.sub, claim.sub]),
      Q.eq(Membership.role, "owner"),
    ),
  )(ws);

// ── operations ───────────────────────────────────────────────────────────────

const Op = Ramose.Operation;

/**
 * Creating a graph is putting a row (#312 §Creating graphs at runtime). The
 * workspace and the creator's access to it commit in ONE transaction — the
 * whole install-then-register dance in Reef's provisionWorkspaceOp (an
 * `db/install` effect, an org/register fetch, seed writes, all non-atomic)
 * collapses into this. `:graph/catalog` stamps itself from the composition's
 * default; the child's storage provisions lazily on first entry.
 */
export const createWsOp = Op(
  "ws/create",
  {
    input: Schema.Struct({
      name: Schema.String,
      doc: Schema.optional(Schema.String),
    }),
    doc: "Create a workspace — the row is the graph",
  },
  (op, input) => {
    const ws = op.put(Ws, { name: input.name, doc: input.doc });
    op.put(Membership, { user: op.principal, ws, role: "owner" });
  },
);

export const addMemberOp = Op(
  "ws/add-member",
  {
    on: Ws,
    input: Schema.Struct({
      sub: Schema.String,
      role: Schema.Literals(["owner", "member"]),
    }),
    doc: "Grant a principal entry to a workspace",
  },
  (op, input) => {
    // Access management is ordinary data: the child's enter function reads
    // this row on the target's next resolution. No token minting, no ACL API.
    op.put(Membership, {
      user: [User.sub, input.sub],
      ws: op.self.eid,
      role: input.role,
    });
  },
);

export const removeMemberOp = Op(
  "ws/remove-member",
  {
    on: Membership,
    input: Schema.Struct({}),
    doc: "Revoke a membership — entry denies within seconds",
  },
  (op) => {
    op.delete(op.self);
  },
);

export const createAgentKeyOp = Op(
  "org/create-agent-key",
  {
    input: Schema.Struct({ doc: Schema.String }),
    output: Schema.Struct({ secret: Schema.String }),
    doc: "Mint an API key for an agent; the secret is returned exactly once",
  },
  (op, input) => {
    const { secret, hash } = op.apiKeys.mint(); // engine-side, run-once — see OpCtx note
    op.put(AgentKey, { hash, sub: `agent:${hash.slice(0, 8)}`, doc: input.doc });
    return { secret };
  },
);

export const operations = Ramose.defineOperations(Org, {
  createWsOp,
  addMemberOp,
  removeMemberOp,
  createAgentKeyOp,
  addTagOp, // registered again here: Ws composes Taggable (see taggable.ts note)
  removeTagOp,
});

// ── policy ───────────────────────────────────────────────────────────────────

export const orgPolicy = Ramose.policy(
  { schema: Org, principal: User.sub, operations },
  {
    user: { read: true },
    ws: {
      // Discovery and entry are separable, both ordinary (#312): `read` is
      // whether the graph row appears in trait queries; `enter` is THE entry
      // decision, run in this graph when a caller opens `org/<name>`. Here
      // they coincide — you can enter what you can list.
      read: memberOf,
      enter: memberOf,
    },
    membership: { read: memberOf }, // rooted at the membership's ws — ergonomics: a rule written for Ws rows reused on Membership rows only works if fragments re-root through the ref; probably needs its own rule
    // agentKey has no read arm: key rows are invisible to everyone but
    // `admins`. Deny by default is the absence, not a `read: false`.
    operations: {
      createWsOp: true, // any signed-in principal may create; "at most N" would be more function here
      addMemberOp: ownerOf,
      removeMemberOp: ownerOf, // target is the Membership row — same re-rooting question as membership.read
      createAgentKeyOp: true,
      addTagOp: memberOf,
      removeTagOp: memberOf,
    },
  },
);

// ── the catalog ──────────────────────────────────────────────────────────────

export const orgCatalog = Ramose.Catalog("org", {
  schema: Org,
  policy: orgPolicy,
});
