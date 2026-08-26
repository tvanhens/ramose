/**
 * Schema-evolution check for `install()`.
 *
 * `schemaTx` is an unconditional upsert; the peer's rebuild accepts the last
 * datom. This module diffs the desired catalog against the installed
 * attribute set and names the flips that would split the data model.
 */

import { isAttributeTx, type SchemaAttrTx, type SchemaTxOp } from "./ensure.ts";
import type {
  IncompatibleKind,
  InstallOptions,
  SchemaChange,
} from "./SchemaErrors.ts";
import { IncompatibleSchema } from "./SchemaErrors.ts";
import { Q, mkVar, q } from "./query/index.ts";

/** One installed attribute, as `install()` reads it back from the peer. */
export interface InstalledAttr {
  /** Attribute entity id, when the catalog read resolved one. */
  readonly e?: number;
  readonly ident: string;
  readonly valueType: string;
  readonly cardinality: string;
  readonly unique?: string;
  readonly optional?: boolean;
  readonly refTarget?: string;
}

/** Retract `:db/optional` so an optional→required flip actually applies. */
export type OptionalRetract = readonly [
  ":db/retract",
  number | readonly [":db/ident", string],
  ":db/optional",
  true,
];

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
const refTargetAttr = { ident: ":ramose/refTarget" } as const;

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

export const installedRefTargetQuery = q(function* () {
  const refTarget = yield* Q.fact(Q._, refTargetAttr);
  return { e: refTarget.e, refTarget: refTarget.v };
});

/**
 * Any entity that asserts one of `idents`. `.one()` so occupancy is a
 * single row or `null`. `install()` must run this against the unfiltered
 * store — a schema class that cannot read the ident would otherwise see
 * `null` and skip an incompatible tighten.
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

export interface InstalledRefTargetRow {
  readonly e: unknown;
  readonly refTarget: unknown;
}

/** Join the catalog queries into one installed-attribute list. */
export const assembleInstalled = (
  core: readonly InstalledCoreRow[],
  uniques: readonly InstalledUniqueRow[],
  optionals: readonly InstalledOptionalRow[],
  refTargets: readonly InstalledRefTargetRow[] = [],
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
  const refTargetByE = new Map<number, string>();
  for (const row of refTargets) {
    const e = eidKey(row.e);
    if (Number.isNaN(e) || typeof row.refTarget !== "string") continue;
    refTargetByE.set(e, row.refTarget);
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
    const refTarget = Number.isNaN(e) ? undefined : refTargetByE.get(e);
    out.push({
      ...(Number.isNaN(e) ? {} : { e }),
      ident: row.ident,
      valueType: row.valueType,
      cardinality: row.cardinality,
      ...(unique === undefined ? {} : { unique }),
      ...(optional ? { optional: true } : {}),
      ...(refTarget === undefined ? {} : { refTarget }),
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
  ...(tx[":ramose/refTarget"] === undefined
    ? {}
    : { refTarget: tx[":ramose/refTarget"] }),
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
 * `occupied` holds namespace names (`favorite`) for required-field
 * checks and attribute idents (`:favorite/target`) for ref-target
 * tightening. A new required field on an occupied namespace is
 * incompatible. Tightening `:ramose/refTarget` is incompatible only
 * when that ident already has values. Dropping a target is a
 * compatible retract.
 */
export const checkEvolution = (
  desiredTx: readonly SchemaTxOp[],
  installed: readonly InstalledAttr[],
  occupied: ReadonlySet<string>,
  options?: InstallOptions,
): IncompatibleSchema | undefined => {
  const allowed = new Set(options?.allowIncompatible ?? []);
  const byIdent = new Map(installed.map((a) => [a.ident, a]));
  const changes: SchemaChange[] = [];

  for (const tx of desiredTx) {
    if (!isAttributeTx(tx)) continue;
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
    // attributeTx only asserts `:db/unique`; a drop is a documented no-op.
    if (desired.unique !== undefined && have.unique !== desired.unique) {
      changes.push(flip(desired.ident, "unique", have.unique, desired.unique));
    }
    if (!isRequiredAttr(have) && isRequiredAttr(desired) && occupied.has(namespaceOf(desired.ident))) {
      changes.push({ ident: desired.ident, kind: "required" });
    }
    if (
      occupied.has(desired.ident) &&
      desired.refTarget !== undefined &&
      have.refTarget !== desired.refTarget
    ) {
      changes.push(
        flip(desired.ident, "refTarget", have.refTarget, desired.refTarget),
      );
    }
  }

  if (changes.length === 0) return undefined;
  return new IncompatibleSchema({
    message: incompatibleMessage(changes),
    changes,
  });
};

/**
 * Namespaces that still need an occupancy read: a new required field
 * or an optional→required flip, not covered by the hatch.
 */
export const namespacesNeedingOccupancy = (
  desiredTx: readonly SchemaTxOp[],
  installed: readonly InstalledAttr[],
  options?: InstallOptions,
): readonly string[] => {
  const allowed = new Set(options?.allowIncompatible ?? []);
  const byIdent = new Map(installed.map((a) => [a.ident, a]));
  const known = installedNamespaces(installed);
  const needed = new Set<string>();
  for (const tx of desiredTx) {
    if (!isAttributeTx(tx)) continue;
    const desired = desiredOf(tx);
    if (allowed.has(desired.ident) || !isRequiredAttr(desired)) continue;
    const ns = namespaceOf(desired.ident);
    if (!known.has(ns)) continue;
    const have = byIdent.get(desired.ident);
    if (have === undefined || !isRequiredAttr(have)) needed.add(ns);
  }
  return [...needed];
};

/**
 * Idents whose existing values must be read before a ref-target tighten
 * can apply. Namespace occupancy is the wrong proxy — an unused optional
 * ref on an otherwise-populated record is safe to target.
 */
export const identsNeedingRefTargetOccupancy = (
  desiredTx: readonly SchemaTxOp[],
  installed: readonly InstalledAttr[],
  options?: InstallOptions,
): readonly string[] => {
  const allowed = new Set(options?.allowIncompatible ?? []);
  const byIdent = new Map(installed.map((a) => [a.ident, a]));
  const needed: string[] = [];
  for (const tx of desiredTx) {
    if (!isAttributeTx(tx)) continue;
    const desired = desiredOf(tx);
    if (allowed.has(desired.ident) || desired.refTarget === undefined) continue;
    const have = byIdent.get(desired.ident);
    if (have === undefined || have.refTarget === desired.refTarget) continue;
    needed.push(desired.ident);
  }
  return needed;
};

const retractSubject = (
  have: InstalledAttr,
): number | readonly [":db/ident", string] =>
  have.e !== undefined ? have.e : [":db/ident", have.ident];

/**
 * Retracts for installed-optional / desired-required attrs. `attributeTx`
 * never retracts `:db/optional`; without these ops the flip is a no-op.
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

/** Retract `:ramose/refTarget` so a targeted→untargeted flip actually applies. */
export type RefTargetRetract = readonly [
  ":db/retract",
  number | readonly [":db/ident", string],
  ":ramose/refTarget",
  string,
];

/**
 * Retracts for installed targeted refs whose desired field is untargeted
 * (`Ref` / `Ref.self`). `attributeTx` omits `:ramose/refTarget`; without
 * these ops the old target stays projected and writes still require it.
 * A change of target is a card-one upsert and needs no retract.
 */
export const refTargetRetracts = (
  desiredTx: readonly SchemaTxOp[],
  installed: readonly InstalledAttr[],
): readonly RefTargetRetract[] => {
  const byIdent = new Map(installed.map((a) => [a.ident, a]));
  const out: RefTargetRetract[] = [];
  for (const tx of desiredTx) {
    if (!isAttributeTx(tx)) continue;
    if (tx[":ramose/refTarget"] !== undefined) continue;
    const have = byIdent.get(tx[":db/ident"]);
    if (have === undefined || have.refTarget === undefined) continue;
    out.push([":db/retract", retractSubject(have), ":ramose/refTarget", have.refTarget]);
  }
  return out;
};

/** Catalog upsert plus the retracts that make optional→required and untargeted refs real. */
export const installTx = (
  desiredTx: readonly SchemaTxOp[],
  installed: readonly InstalledAttr[],
): readonly unknown[] => [
  ...desiredTx,
  ...optionalRetracts(desiredTx, installed),
  ...refTargetRetracts(desiredTx, installed),
];
