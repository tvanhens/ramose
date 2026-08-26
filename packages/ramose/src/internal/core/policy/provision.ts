/**
 * Peer-owned principal provisioning: upsert the row the policy's `principal`
 * attr names, materialize the token class as a sibling `:ns/role` fact when
 * that attribute exists, and stamp each `ramose.attrs` key onto `:ns/${key}`
 * when the sibling attr is deployed and the JS type matches.
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

/** `:user/sub` + `"name"` → `:user/name`. */
export function siblingIdentOf(principalAttr: string, name: string): string {
  const slash = principalAttr.lastIndexOf("/");
  return slash <= 0 ? `${principalAttr}/${name}` : `${principalAttr.slice(0, slash)}/${name}`;
}

/** `:user/sub` + `"role"` → `:user/role`. */
export function roleIdentOf(principalAttr: string): string {
  return siblingIdentOf(principalAttr, ROLE_NAME);
}

const isStringAttr = (attr: Attribute): boolean => attr.valueType === ValueTag.Str;

/** Names the peer already owns on this row — attrs must not overwrite them. */
const reservedNames = (principalAttr: string): Set<string> => {
  const slash = principalAttr.lastIndexOf("/");
  const principalName = slash <= 0 ? principalAttr : principalAttr.slice(slash + 1);
  return new Set([principalName, ROLE_NAME]);
};

/** JWT attrs are JSON primitives; skip refs, instants, bytes, and many-cards. */
const valueMatchesAttr = (attr: Attribute, value: unknown): boolean => {
  if (attr.cardinality !== "one") return false;
  switch (attr.valueType) {
    case ValueTag.Str:
      return typeof value === "string";
    case ValueTag.Bool:
      return typeof value === "boolean";
    case ValueTag.Long:
      return typeof value === "number" && Number.isSafeInteger(value);
    case ValueTag.Double:
      return typeof value === "number" && Number.isFinite(value);
    default:
      return false;
  }
};

const factsMatch = (ent: Record<string, unknown>, wanted: Record<string, unknown>): boolean => {
  for (const [ident, value] of Object.entries(wanted)) {
    if (ent[ident] !== value) return false;
  }
  return true;
};

/**
 * The map of idents the peer wants on this principal row, or `undefined`
 * when there is nothing to own (no row owed, or the principal attr is not
 * deployed as unique-identity).
 */
export function wantedFacts(
  policy: CompiledPolicy,
  principal: Principal,
  db: Db,
): Record<string, unknown> | undefined {
  if (!shouldProvision(principal)) return undefined;
  const ident = policy.principal;
  const attr = db.attr(ident);
  if (attr === undefined || attr.unique !== "identity") return undefined;

  const map: Record<string, unknown> = { [ident]: principal.sub };
  const roleIdent = roleIdentOf(ident);
  const roleAttr = db.attr(roleIdent);
  if (roleAttr !== undefined && isStringAttr(roleAttr)) map[roleIdent] = principal.class;

  const reserved = reservedNames(ident);
  for (const [key, value] of Object.entries(principal.claims.attrs ?? {})) {
    if (reserved.has(key) || value === undefined || value === null) continue;
    const sibling = siblingIdentOf(ident, key);
    const siblingAttr = db.attr(sibling);
    if (siblingAttr === undefined || !valueMatchesAttr(siblingAttr, value)) continue;
    map[sibling] = value;
  }
  return map;
}

/**
 * The map-form upsert to run, or `undefined` when there is nothing to write:
 * no row is owed, the principal attr is not deployed, or the row already
 * carries every wanted fact (`sub`, role, and matching attrs).
 */
export async function provisionTx(policy: CompiledPolicy, principal: Principal, db: Db): Promise<unknown[] | undefined> {
  const map = wantedFacts(policy, principal, db);
  if (map === undefined) return undefined;

  const eid = await db.entid([policy.principal, principal.sub] as never);
  if (eid !== undefined) {
    const ent = await db.entity(eid);
    if (ent !== undefined && factsMatch(ent, map)) return undefined;
  }
  return [map];
}

/** Resolve `sub` through the policy's principal attr. */
export async function resolveProvisionedEid(policy: CompiledPolicy, principal: Principal, db: Db): Promise<number | undefined> {
  if (!shouldProvision(principal)) return principal.eid;
  if (principal.eid !== undefined) return principal.eid;
  // Schema may not be installed yet (first authenticated write on an empty
  // policed db). `entid` throws on an unknown attr; skip until it exists.
  // Lookup refs are valid for every unique attr (`identity` or `value`);
  // `wantedFacts` still refuses to *write* a strict unique principal.
  const attr = db.attr(policy.principal);
  if (attr === undefined || attr.unique === undefined) return undefined;
  return db.entid([policy.principal, principal.sub] as never);
}
