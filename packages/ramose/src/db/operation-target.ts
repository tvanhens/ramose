/**
 * Runtime target check for contextual operations. Membership facts
 * (`:ramose/type`, `:ramose/trait`) win when present; entity-only
 * schemas without those facts fall back to a namespace-prefix scan.
 */

import { composerIdent } from "./compose.ts";

const RAMOSE_TYPE_IDENT = ":ramose/type";
const RAMOSE_TRAIT_IDENT = ":ramose/trait";

export type OperationTargetKind = "entity" | "trait";

export type OperationTargetCheck = "ok" | "dangling" | "foreign";

export type OperationTargetOwner = {
  readonly _tag?: string;
  readonly ns: string;
};

/** Schema-derived traits of a `:ramose/type` ident (`:issue` → `:taggable`). */
export type TraitsOfType = (typeIdent: string) => readonly string[];

export type OperationTargetContext = {
  readonly traitsOfType?: TraitsOfType;
};

const asList = (value: unknown): readonly unknown[] => {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
};

const userKeys = (row: Readonly<Record<string, unknown>>): readonly string[] =>
  Object.keys(row).filter((key) => key !== ":db/id" && !key.startsWith(":db/"));

/** Namespace prefixes of user fields (`:issue/title` → `:issue`). */
const typeIdentsFromKeys = (keys: readonly string[]): readonly string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const key of keys) {
    if (
      !key.startsWith(":") ||
      key === RAMOSE_TYPE_IDENT ||
      key === RAMOSE_TRAIT_IDENT
    ) {
      continue;
    }
    const slash = key.indexOf("/", 1);
    if (slash <= 1) continue;
    const typeIdent = key.slice(0, slash);
    if (seen.has(typeIdent)) continue;
    seen.add(typeIdent);
    out.push(typeIdent);
  }
  return out;
};

export const targetKindOf = (
  owner: OperationTargetOwner,
): OperationTargetKind => (owner._tag === "Trait" ? "trait" : "entity");

/**
 * Classify a resolved row against the operation's target owner.
 * Callers must resolve the eid on the filtered view first — a missing
 * row is `dangling` whether or not the unfiltered db has it.
 */
export const checkOperationTarget = (
  row: Readonly<Record<string, unknown>> | undefined,
  owner: OperationTargetOwner,
  context?: OperationTargetContext,
): OperationTargetCheck => {
  if (row === undefined) return "dangling";
  const ident = composerIdent(owner.ns);
  if (targetKindOf(owner) === "trait") {
    const traits = asList(row[RAMOSE_TRAIT_IDENT]);
    if (traits.includes(ident)) return "ok";
    const type = row[RAMOSE_TYPE_IDENT];
    const keys = userKeys(row).filter(
      (key) => key !== RAMOSE_TYPE_IDENT && key !== RAMOSE_TRAIT_IDENT,
    );
    if (context?.traitsOfType !== undefined) {
      if (typeof type === "string") {
        return context.traitsOfType(type).includes(ident) ? "ok" : "foreign";
      }
      const inferred = typeIdentsFromKeys(keys);
      if (
        inferred.some((candidate) => context.traitsOfType!(candidate).includes(ident))
      ) {
        return "ok";
      }
      // A concrete foreign namespace already answered "not a composer".
      // Do not let a stray trait-prefixed field revive the prefix fallback.
      if (inferred.some((candidate) => candidate !== ident)) return "foreign";
    }
    if (traits.length === 0 && typeof type !== "string") {
      if (keys.length === 0) return "dangling";
      const prefix = `${ident}/`;
      return keys.some((key) => key.startsWith(prefix)) ? "ok" : "foreign";
    }
    return "foreign";
  }
  const type = row[RAMOSE_TYPE_IDENT];
  if (typeof type === "string") {
    return type === ident ? "ok" : "foreign";
  }
  const keys = userKeys(row).filter(
    (key) => key !== RAMOSE_TYPE_IDENT && key !== RAMOSE_TRAIT_IDENT,
  );
  if (keys.length === 0) return "dangling";
  const prefix = `${ident}/`;
  return keys.some((key) => key.startsWith(prefix)) ? "ok" : "foreign";
};
