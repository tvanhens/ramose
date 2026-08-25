/**
 * Better Auth organization access control, shared by the auth Worker and the
 * browser client (the module is isomorphic). Built-in owner/admin/member
 * permission sets plus a custom `viewer` role with no permissions at all —
 * the role decides the `ramose.class` claim (`ramose/better-auth`'s
 * `classOfRole`, the mint plugin's default mapping), and
 * the compiled Ramose policy is what enforces it on the data plane.
 */

import { createAccessControl } from "better-auth/plugins/access";
import {
  adminAc,
  defaultStatements,
  memberAc,
  ownerAc,
} from "better-auth/plugins/organization/access";

export const ac = createAccessControl(defaultStatements);

export const roles = {
  owner: ac.newRole(ownerAc.statements),
  admin: ac.newRole(adminAc.statements),
  member: ac.newRole(memberAc.statements),
  viewer: ac.newRole({}),
};

/** The roles the invite dialog offers (creators are `owner` automatically). */
export const INVITABLE_ROLES = ["admin", "member", "viewer"] as const;
