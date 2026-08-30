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

export const INVITABLE_ROLES = ["admin", "member", "viewer"] as const;
