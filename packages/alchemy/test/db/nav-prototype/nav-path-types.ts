/**
 * Compile-time gate for issue #18: `Todo.owner.friends.name`.
 *
 * `bun run typecheck` includes this file. Failures show up as ordinary
 * type errors (or unused `@ts-expect-error`). Diagnostics for this slice
 * alone live in `docs/QUERY_TYPING.md` (regenerate via `measure.sh`).
 */

import type * as Schema from "effect/Schema";
import type { Equal, Expect } from "../../../src/db/equal.ts";
import {
  Comment,
  IfaceTodo,
  IfaceUser,
  Todo,
  User,
} from "./fixture.ts";
import type { AttrNameOf, IdentOf } from "./types.ts";

// ── Encoding A — depth-capped Namespace inference ──────────────────────────

// Gate path from QUERY.md / issue #18
type OwnerFriendsName = typeof Todo.owner.friends.name;
type _gateIdent = Expect<Equal<IdentOf<OwnerFriendsName>, ":user/name">>;
type _gateAttrName = Expect<Equal<AttrNameOf<OwnerFriendsName>, "name">>;
type _gateSchema = Expect<
  Equal<OwnerFriendsName["schema"], typeof Schema.String>
>;

// One hop
type _ownerIdent = Expect<Equal<IdentOf<typeof Todo.owner>, ":todo/owner">>;
type _ownerName = Expect<
  Equal<IdentOf<typeof Todo.owner.name>, ":user/name">
>;

// Self-ref on User
type _friendsName = Expect<
  Equal<IdentOf<typeof User.friends.name>, ":user/name">
>;
type _friendsFriendsName = Expect<
  Equal<IdentOf<typeof User.friends.friends.name>, ":user/name">
>;

// Comment → User → friends → name
type _commentAuthorFriend = Expect<
  Equal<IdentOf<typeof Comment.author.friends.name>, ":user/name">
>;

// Self on Comment
type _replyBody = Expect<
  Equal<IdentOf<typeof Comment.replyTo.body>, ":comment/body">
>;

// Scalar attrs must NOT navigate into another namespace's attrs.
// @ts-expect-error title is not a ref — no .friends hop
const _scalarNav: typeof Todo.title.friends = null as never;

// ── Encoding B — interface-deferred ────────────────────────────────────────

type IfaceGate = typeof IfaceTodo.owner.friends.name;
type _ifaceGate = Expect<Equal<IdentOf<IfaceGate>, ":user/name">>;
type _ifaceDeep = Expect<
  Equal<
    IdentOf<typeof IfaceTodo.owner.friends.friends.friends.name>,
    ":user/name"
  >
>;
type _ifaceUserFriends = Expect<
  Equal<IdentOf<typeof IfaceUser.friends.name>, ":user/name">
>;

// Runtime smoke anchors (also asserted in nav-prototype.test.ts).
export const _keep = {
  path: Todo.owner.friends.name.ident,
  iface: IfaceTodo.owner.friends.name.ident,
  deep: IfaceTodo.owner.friends.friends.friends.name.ident,
};
