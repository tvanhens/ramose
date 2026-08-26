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

const asList = (value: unknown): readonly unknown[] => {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
};

const userKeys = (row: Readonly<Record<string, unknown>>): readonly string[] =>
  Object.keys(row).filter((key) => key !== ":db/id" && !key.startsWith(":db/"));

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
): OperationTargetCheck => {
  if (row === undefined) return "dangling";
  const ident = composerIdent(owner.ns);
  if (targetKindOf(owner) === "trait") {
    const traits = asList(row[RAMOSE_TRAIT_IDENT]);
    return traits.includes(ident) ? "ok" : "foreign";
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
