/**
 * Schema-evolution check for `install()`.
 *
 * `schemaTx` is an unconditional upsert; the peer's rebuild accepts the last
 * datom. This module diffs the desired catalog against the installed
 * attribute set and names the flips that would split the data model.
 */

import * as Data from "effect/Data";
import type { SchemaAttrTx } from "./ensure.ts";
import { Q, mkVar, q } from "./query/index.ts";

/** Opt-in listed on `db.install({ allowIncompatible })`. */
export interface InstallOptions {
  /**
   * Idents (`:todo/title`) whose incompatible flips — value type,
   * cardinality, uniqueness, or a new required field on existing rows —
   * are applied anyway. Unlisted idents still fail the check.
   */
  readonly allowIncompatible?: readonly string[];
}

export type IncompatibleKind = "valueType" | "cardinality" | "unique" | "required";

export interface SchemaChange {
  readonly ident: string;
  readonly kind: IncompatibleKind;
  /** Installed wire value; absent on a new required field. */
  readonly from?: string;
  /** Desired wire value; absent on a new required field. */
  readonly to?: string;
}

/**
 * `install()` refused a change that would split the data model. Not a
 * {@link import("./Errors.ts").DbError} — the write never left the client.
 * Match with `instanceof` or `_tag`.
 */
export class IncompatibleSchema extends Data.TaggedError("IncompatibleSchema")<{
  readonly message: string;
  readonly changes: readonly SchemaChange[];
}> {}

/** One installed attribute, as `install()` reads it back from the peer. */
export interface InstalledAttr {
  readonly ident: string;
  readonly valueType: string;
  readonly cardinality: string;
  readonly unique?: string;
  readonly optional?: boolean;
}

const SYSTEM_PREFIX = ":db/";

export const isSystemIdent = (ident: string): boolean =>
  ident.startsWith(SYSTEM_PREFIX);

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

const identAttr = { ident: ":db/ident" } as const;
const valueTypeAttr = { ident: ":db/valueType" } as const;
const cardinalityAttr = { ident: ":db/cardinality" } as const;
const uniqueAttr = { ident: ":db/unique" } as const;
const optionalAttr = { ident: ":db/optional" } as const;

/** Every attribute entity: ident + valueType + cardinality. */
export const installedCoreQuery = q(function* () {
  const ident = yield* Q.fact(Q._, identAttr);
  const valueType = yield* Q.fact(ident.e, valueTypeAttr);
  const cardinality = yield* Q.fact(ident.e, cardinalityAttr);
  return {
    e: ident.e,
    ident: ident.v,
    valueType: valueType.v,
    cardinality: cardinality.v,
  };
});

export const installedUniqueQuery = q(function* () {
  const unique = yield* Q.fact(Q._, uniqueAttr);
  return { e: unique.e, unique: unique.v };
});

export const installedOptionalQuery = q(function* () {
  const optional = yield* Q.fact(Q._, optionalAttr);
  return { e: optional.e, optional: optional.v };
});

/**
 * Any entity that asserts one of `idents`. `.one()` so occupancy is a
 * single row or `null`.
 */
export const occupancyQuery = (idents: readonly string[]) => {
  const listed = idents.filter((ident) => ident.length > 0);
  return q(function* () {
    const e = mkVar("entity");
    if (listed.length === 1) {
      yield* Q.fact(e, { ident: listed[0]! });
    } else {
      yield* Q.or(
        ...listed.map(
          (ident) =>
            function* () {
              yield* Q.fact(e, { ident });
            },
        ),
      );
    }
    return e;
  }).one();
};

const eidKey = (e: unknown): number => {
  if (typeof e === "number" && Number.isFinite(e)) return e;
  if (typeof e === "object" && e !== null && "id" in e) {
    const id = (e as { id: unknown }).id;
    if (typeof id === "number" && Number.isFinite(id)) return id;
  }
  return Number.NaN;
};

export interface InstalledCoreRow {
  readonly e: unknown;
  readonly ident: unknown;
  readonly valueType: unknown;
  readonly cardinality: unknown;
}

export interface InstalledUniqueRow {
  readonly e: unknown;
  readonly unique: unknown;
}

export interface InstalledOptionalRow {
  readonly e: unknown;
  readonly optional: unknown;
}

/** Join the three catalog queries into one installed-attribute list. */
export const assembleInstalled = (
  core: readonly InstalledCoreRow[],
  uniques: readonly InstalledUniqueRow[],
  optionals: readonly InstalledOptionalRow[],
): InstalledAttr[] => {
  const uniqueByE = new Map<number, string>();
  for (const row of uniques) {
    const e = eidKey(row.e);
    if (Number.isNaN(e) || typeof row.unique !== "string") continue;
    uniqueByE.set(e, row.unique);
  }
  const optionalByE = new Set<number>();
  for (const row of optionals) {
    const e = eidKey(row.e);
    if (Number.isNaN(e)) continue;
    if (row.optional === true) optionalByE.add(e);
  }
  const out: InstalledAttr[] = [];
  for (const row of core) {
    if (typeof row.ident !== "string" || isSystemIdent(row.ident)) continue;
    if (typeof row.valueType !== "string" || typeof row.cardinality !== "string") {
      continue;
    }
    const e = eidKey(row.e);
    const unique = Number.isNaN(e) ? undefined : uniqueByE.get(e);
    const optional = !Number.isNaN(e) && optionalByE.has(e);
    out.push({
      ident: row.ident,
      valueType: row.valueType,
      cardinality: row.cardinality,
      ...(unique === undefined ? {} : { unique }),
      ...(optional ? { optional: true } : {}),
    });
  }
  return out;
};

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
): SchemaChange => ({ ident, kind, from, to });

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
    return `${change.ident} is a new required field on a namespace that already has entities — a default or a migration step is required`;
  }
  const from = change.from ?? "none";
  const to = change.to ?? "none";
  return `${change.ident} ${change.kind} ${from} → ${to}`;
};

export const incompatibleMessage = (changes: readonly SchemaChange[]): string => {
  const listed = changes.map((c) => c.ident);
  const hatch =
    listed.length === 0
      ? ""
      : ` Pass install({ allowIncompatible: [${listed.map((id) => JSON.stringify(id)).join(", ")}] }) to apply them anyway.`;
  return `ramose: install() refused incompatible schema changes: ${changes.map(formatChange).join("; ")}.${hatch}`;
};

/**
 * Diff the desired catalog against the installed attribute set.
 *
 * `occupied` is the set of namespaces that already have at least one
 * entity. A new required field (or an optional→required flip) on an
 * occupied namespace is incompatible.
 */
export const checkEvolution = (
  desiredTx: readonly SchemaAttrTx[],
  installed: readonly InstalledAttr[],
  occupied: ReadonlySet<string>,
  options?: InstallOptions,
): IncompatibleSchema | undefined => {
  const allowed = new Set(options?.allowIncompatible ?? []);
  const byIdent = new Map(installed.map((a) => [a.ident, a]));
  const changes: SchemaChange[] = [];

  for (const tx of desiredTx) {
    const desired = desiredOf(tx);
    if (allowed.has(desired.ident)) continue;
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
      changes.push(
        flip(desired.ident, "cardinality", have.cardinality, desired.cardinality),
      );
    }
    if ((have.unique ?? undefined) !== (desired.unique ?? undefined)) {
      changes.push(flip(desired.ident, "unique", have.unique, desired.unique));
    }
    if (!isRequiredAttr(have) && isRequiredAttr(desired) && occupied.has(namespaceOf(desired.ident))) {
      changes.push({ ident: desired.ident, kind: "required" });
    }
  }

  if (changes.length === 0) return undefined;
  return new IncompatibleSchema({
    message: incompatibleMessage(changes),
    changes,
  });
};

/**
 * Namespaces that still need an occupancy read: a new required field, or
 * an optional→required flip, not covered by the hatch.
 */
export const namespacesNeedingOccupancy = (
  desiredTx: readonly SchemaAttrTx[],
  installed: readonly InstalledAttr[],
  options?: InstallOptions,
): readonly string[] => {
  const allowed = new Set(options?.allowIncompatible ?? []);
  const byIdent = new Map(installed.map((a) => [a.ident, a]));
  const known = installedNamespaces(installed);
  const needed = new Set<string>();
  for (const tx of desiredTx) {
    const desired = desiredOf(tx);
    if (allowed.has(desired.ident) || !isRequiredAttr(desired)) continue;
    const ns = namespaceOf(desired.ident);
    if (!known.has(ns)) continue;
    const have = byIdent.get(desired.ident);
    if (have === undefined || !isRequiredAttr(have)) needed.add(ns);
  }
  return [...needed];
};
