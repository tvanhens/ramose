/** Schema-layer tagged failures: `install()` refused a data-model split.
 * Lives here so the client `.d.ts` hop is the allowlisted `Errors` module —
 * not a new Effect import. */

import * as Data from "effect/Data";

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
