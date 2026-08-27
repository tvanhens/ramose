/**
 * Opaque snapshot handles for the three TCB capabilities.
 *
 * Distinct types, never subtypes of one another or of physical `Db`.
 * Inheritance, casts, public constructors, and generic `Db` passing must
 * not recover a more privileged capability (TCB-1).
 *
 * #339 constructs real snapshots. These brands exist so later wiring
 * cannot accidentally reuse the legacy `FilteredDb extends Db` hatch.
 *
 * @internal
 */

declare const RawSnapshotBrand: unique symbol;
declare const RuleSnapshotBrand: unique symbol;
declare const ApplicationSnapshotBrand: unique symbol;

/** Privileged facts at a named basis. Storage, transactor, indexer only. */
export type RawSnapshot = {
  readonly [RawSnapshotBrand]: never;
  readonly basisT: number;
};

/** Trusted current rule basis for grant and traversal lookup. */
export type RuleSnapshot = {
  readonly [RuleSnapshotBrand]: never;
  readonly basisT: number;
};

/** Principal-filtered facts only. The sole handle query/pull/live may see. */
export type ApplicationSnapshot = {
  readonly [ApplicationSnapshotBrand]: never;
  readonly basisT: number;
};
