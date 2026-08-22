/**
 * Peer-owned principal provisioning: upsert the row the policy's `principal`
 * attr names, and materialize the token class as a sibling `:ns/role` fact
 * when that attribute exists.
 *
 * Clients never write this row. Anonymous and service principals have no
 * `sub` and stay unresolved — deny-by-default still applies.
 */

import { ValueTag } from "../datom.ts";
import type { Db } from "../db.ts";
import type { Attribute } from "../schema.ts";
import type { CompiledPolicy } from "./ast.ts";
import type { Principal } from "./principal.ts";

/** The fact name the peer writes next to the principal attr (`:user/sub` → `:user/role`). */
export const ROLE_NAME = "role";

/** A signed-in user with a `sub` — the only kind the peer will write a row for. */
export function shouldProvision(principal: Principal): boolean {
  return principal.kind === "user" && typeof principal.sub === "string" && principal.sub.length > 0;
}

/** `:user/sub` + `"role"` → `:user/role`. */
export function roleIdentOf(principalAttr: string): string {
  const slash = principalAttr.lastIndexOf("/");
  return slash <= 0 ? `${principalAttr}/${ROLE_NAME}` : `${principalAttr.slice(0, slash)}/${ROLE_NAME}`;
}

const isStringAttr = (attr: Attribute): boolean => attr.valueType === ValueTag.Str;

/**
 * The map-form upsert to run, or `undefined` when there is nothing to write:
 * no row is owed, the principal attr is not deployed, or the row already
 * carries this `sub` (and role, when the attr exists).
 */
export async function provisionTx(policy: CompiledPolicy, principal: Principal, db: Db): Promise<unknown[] | undefined> {
  if (!shouldProvision(principal)) return undefined;
  const ident = policy.principal;
  const attr = db.attr(ident);
  if (attr === undefined || attr.unique !== "identity") return undefined;

  const roleIdent = roleIdentOf(ident);
  const roleAttr = db.attr(roleIdent);
  const wantRole = roleAttr !== undefined && isStringAttr(roleAttr) ? principal.class : undefined;

  const eid = await db.entid([ident, principal.sub] as never);
  if (eid !== undefined) {
    if (wantRole === undefined) return undefined;
    const ent = await db.entity(eid);
    if (ent?.[roleIdent] === wantRole) return undefined;
  }

  const map: Record<string, unknown> = { [ident]: principal.sub };
  if (wantRole !== undefined) map[roleIdent] = wantRole;
  return [map];
}

/** Resolve `sub` through the policy's principal attr. */
export async function resolveProvisionedEid(policy: CompiledPolicy, principal: Principal, db: Db): Promise<number | undefined> {
  if (!shouldProvision(principal)) return principal.eid;
  if (principal.eid !== undefined) return principal.eid;
  return db.entid([policy.principal, principal.sub] as never);
}
