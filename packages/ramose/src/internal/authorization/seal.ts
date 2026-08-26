/** Deep-freeze installed artifacts before publication. */

import {
  InstalledBrand,
  type InstalledAuthorizationIR,
  type SealedInstalledAuthorizationIR,
} from "./installed.ts";

const deepFreeze = <T>(value: T): T => {
  if (value === null || typeof value !== "object") return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return value;
  }
  for (const key of Object.keys(value as object)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
};

/**
 * Convert a validated installed document into a sealed internal structure.
 * Runtime mutation after validation is forbidden.
 */
export const sealInstalled = (
  installed: InstalledAuthorizationIR,
): SealedInstalledAuthorizationIR => {
  const clone = structuredClone(installed) as InstalledAuthorizationIR;
  const branded = Object.assign(clone, {
    [InstalledBrand]: InstalledBrand,
  }) as SealedInstalledAuthorizationIR;
  return deepFreeze(branded);
};

export const freezeJson = <T>(value: T): T => deepFreeze(structuredClone(value));
