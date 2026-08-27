/**
 * Immutable copies of verified principals retained on snapshot state.
 *
 * Claim values are recursively frozen so array-valued claims cannot be
 * mutated through a live snapshot handle during the lease.
 *
 * @internal
 */

import type { AuthorizationPrincipal } from "../principal.ts";

export const freezeDeep = (value: unknown): void => {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
  if (Array.isArray(value)) {
    for (const item of value) freezeDeep(item);
  } else {
    for (const key of Object.keys(value)) {
      freezeDeep((value as Record<string, unknown>)[key]);
    }
  }
  Object.freeze(value);
};

export const freezePrincipal = (principal: AuthorizationPrincipal): AuthorizationPrincipal => {
  const cloned = structuredClone(principal) as AuthorizationPrincipal;
  freezeDeep(cloned);
  return cloned;
};
