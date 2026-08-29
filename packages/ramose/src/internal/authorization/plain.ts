import type { JsonValue } from "./json.ts";

/**
 * Deep-copy JSON-shaped data so later freeze cannot seal caller-owned
 * template, descriptor, or identity objects the result still names.
 */
export const clonePlain = <T>(value: T): T => {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => clonePlain(item)) as T;
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    copy[key] = clonePlain((value as Record<string, unknown>)[key]);
  }
  return copy as T;
};

export const freezePlain = <T>(value: T): T => {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) freezePlain(item);
  } else {
    for (const key of Object.keys(value)) {
      freezePlain((value as Record<string, unknown>)[key]);
    }
  }
  return Object.freeze(value);
};

export const freezeBound = <T>(value: T): T => freezePlain(clonePlain(value));

export const encodedJson = (encoded: unknown): JsonValue => encoded as JsonValue;

export const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export const remapRuleIds = <Id>(
  ids: ReadonlyArray<Id>,
  map: ReadonlyMap<Id, Id>,
): ReadonlyArray<Id> => ids.map((id) => map.get(id) ?? id);

export const remapDecision = <Id>(
  decision: { readonly allow: ReadonlyArray<Id>; readonly deny: ReadonlyArray<Id> },
  map: ReadonlyMap<Id, Id>,
): { readonly allow: ReadonlyArray<Id>; readonly deny: ReadonlyArray<Id> } => ({
  allow: remapRuleIds(decision.allow, map),
  deny: remapRuleIds(decision.deny, map),
});
