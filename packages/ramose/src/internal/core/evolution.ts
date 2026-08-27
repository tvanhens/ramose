/**
 * Schema-evolution check for catalog publication.
 *
 * Catalog attribute maps are an unconditional upsert; the peer rebuild
 * accepts the last datom. This module diffs the desired catalog against
 * the installed attribute set and names the flips that would split the
 * data model. Pure — no client install path, no query language.
 */

import { isAttributeTx, type SchemaAttrTx, type SchemaTxOp } from "../../db/ensure.ts";

/** One installed attribute, as publication reads it from db-before. */
export interface InstalledAttr {
  /** Attribute entity id, when the catalog read resolved one. */
  readonly e?: number;
  readonly ident: string;
  readonly valueType: string;
  readonly cardinality: string;
  readonly unique?: string;
  readonly optional?: boolean;
}

/** Retract `:db/optional` so an optional→required flip actually applies. */
export type OptionalRetract = readonly [
  ":db/retract",
  number | readonly [":db/ident", string],
  ":db/optional",
  true,
];

export type IncompatibleKind = "valueType" | "cardinality" | "unique" | "required";

export interface SchemaChange {
  readonly ident: string;
  readonly kind: IncompatibleKind;
  /** Installed wire value; absent on a new required field. */
  readonly from?: string;
  /** Desired wire value; absent on a new required field. */
  readonly to?: string;
}

/** Result of {@link checkEvolution} when the desired catalog is incompatible. */
export interface IncompatibleSchema {
  readonly message: string;
  readonly changes: readonly SchemaChange[];
}

const SYSTEM_PREFIX = ":db/";

export const isSystemIdent = (ident: string): boolean => ident.startsWith(SYSTEM_PREFIX);

/** `:user/name` → `user`. */
export const namespaceOf = (ident: string): string => {
  if (!ident.startsWith(":")) return "";
  const slash = ident.indexOf("/", 1);
  return slash < 0 ? "" : ident.slice(1, slash);
};

const CARD_MANY = ":db.cardinality/many";

export const isRequiredAttr = (attr: {
  readonly cardinality: string;
  readonly optional?: boolean;
}): boolean => attr.cardinality !== CARD_MANY && attr.optional !== true;

const desiredOf = (tx: SchemaAttrTx): InstalledAttr => ({
  ident: tx[":db/ident"],
  valueType: tx[":db/valueType"],
  cardinality: tx[":db/cardinality"],
  ...(tx[":db/unique"] === undefined ? {} : { unique: tx[":db/unique"] }),
  ...(tx[":db/optional"] === true ? { optional: true } : {}),
});

const flip = (
  ident: string,
  kind: Exclude<IncompatibleKind, "required">,
  from: string | undefined,
  to: string | undefined,
): SchemaChange => ({
  ident,
  kind,
  ...(from !== undefined && { from }),
  ...(to !== undefined && { to }),
});

/**
 * Namespaces that already have attributes installed — those are the ones
 * a new required field would land on existing rows of.
 */
export const installedNamespaces = (
  installed: readonly InstalledAttr[],
): ReadonlySet<string> => {
  const ns = new Set<string>();
  for (const attr of installed) {
    const name = namespaceOf(attr.ident);
    if (name.length > 0) ns.add(name);
  }
  return ns;
};

/** Existing idents in `ns`, card-one first so occupancy prefers required keys. */
export const occupancyIdents = (
  installed: readonly InstalledAttr[],
  ns: string,
): string[] => {
  const attrs = installed.filter((a) => namespaceOf(a.ident) === ns);
  const one: string[] = [];
  const many: string[] = [];
  for (const a of attrs) {
    (a.cardinality === CARD_MANY ? many : one).push(a.ident);
  }
  return [...one, ...many];
};

const formatChange = (change: SchemaChange): string => {
  if (change.kind === "required") {
    return `${change.ident} is a new required field on a namespace that already has entities`;
  }
  const from = change.from ?? "none";
  const to = change.to ?? "none";
  return `${change.ident} ${change.kind} ${from} → ${to}`;
};

export const incompatibleMessage = (changes: readonly SchemaChange[]): string =>
  `incompatible schema changes: ${changes.map(formatChange).join("; ")}`;

/**
 * Diff the desired catalog against the installed attribute set.
 *
 * `occupied` is the set of namespaces that already have at least one
 * entity. A new required field (or an optional→required flip) on an
 * occupied namespace is incompatible.
 */
export const checkEvolution = (
  desiredTx: readonly SchemaTxOp[],
  installed: readonly InstalledAttr[],
  occupied: ReadonlySet<string>,
): IncompatibleSchema | undefined => {
  const byIdent = new Map(installed.map((a) => [a.ident, a]));
  const changes: SchemaChange[] = [];

  for (const tx of desiredTx) {
    if (!isAttributeTx(tx)) continue;
    const desired = desiredOf(tx);
    const have = byIdent.get(desired.ident);
    if (have === undefined) {
      if (isRequiredAttr(desired) && occupied.has(namespaceOf(desired.ident))) {
        changes.push({ ident: desired.ident, kind: "required" });
      }
      continue;
    }
    if (have.valueType !== desired.valueType) {
      changes.push(flip(desired.ident, "valueType", have.valueType, desired.valueType));
    }
    if (have.cardinality !== desired.cardinality) {
      changes.push(flip(desired.ident, "cardinality", have.cardinality, desired.cardinality));
    }
    // attributeTx only asserts `:db/unique`; a drop is a documented no-op.
    if (desired.unique !== undefined && have.unique !== desired.unique) {
      changes.push(flip(desired.ident, "unique", have.unique, desired.unique));
    }
    if (!isRequiredAttr(have) && isRequiredAttr(desired) && occupied.has(namespaceOf(desired.ident))) {
      changes.push({ ident: desired.ident, kind: "required" });
    }
  }

  if (changes.length === 0) return undefined;
  return { message: incompatibleMessage(changes), changes };
};

/**
 * Namespaces that still need an occupancy read: a new required field, or
 * an optional→required flip.
 */
export const namespacesNeedingOccupancy = (
  desiredTx: readonly SchemaTxOp[],
  installed: readonly InstalledAttr[],
): readonly string[] => {
  const byIdent = new Map(installed.map((a) => [a.ident, a]));
  const known = installedNamespaces(installed);
  const needed = new Set<string>();
  for (const tx of desiredTx) {
    if (!isAttributeTx(tx)) continue;
    const desired = desiredOf(tx);
    if (!isRequiredAttr(desired)) continue;
    const ns = namespaceOf(desired.ident);
    if (!known.has(ns)) continue;
    const have = byIdent.get(desired.ident);
    if (have === undefined || !isRequiredAttr(have)) needed.add(ns);
  }
  return [...needed];
};

const retractSubject = (
  have: InstalledAttr,
): number | readonly [":db/ident", string] =>
  have.e !== undefined ? have.e : [":db/ident", have.ident];

/**
 * Retracts for installed-optional / desired-required attrs. Attribute maps
 * never retract `:db/optional`; without these ops the flip is a no-op.
 */
export const optionalRetracts = (
  desiredTx: readonly SchemaTxOp[],
  installed: readonly InstalledAttr[],
): readonly OptionalRetract[] => {
  const byIdent = new Map(installed.map((a) => [a.ident, a]));
  const out: OptionalRetract[] = [];
  for (const tx of desiredTx) {
    if (!isAttributeTx(tx)) continue;
    const desired = desiredOf(tx);
    const have = byIdent.get(desired.ident);
    if (have === undefined || !isRequiredAttr(desired)) continue;
    if (have.optional !== true) continue;
    out.push([":db/retract", retractSubject(have), ":db/optional", true]);
  }
  return out;
};

/** Catalog upsert plus the retracts that make optional→required real. */
export const installTx = (
  desiredTx: readonly SchemaTxOp[],
  installed: readonly InstalledAttr[],
): readonly unknown[] => [...desiredTx, ...optionalRetracts(desiredTx, installed)];
