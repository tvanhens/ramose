/** The one schema-layer tagged failure: a policy that did not compile. */

import * as Data from "effect/Data";

/**
 * A policy did not compile against its catalog — an ident the schema does not
 * declare, a rule body the query validator rejects, a read-masked attribute a
 * pull pattern requires. Deploy/compile time only; a policy never throws into a
 * query.
 *
 * Provisioning mistakes elsewhere are defects, not failures: a malformed URL,
 * a missing binding, a `db.install()` that cannot reach the peer all surface
 * as `Effect.die` or one of the nine `DbError`s.
 */
export class PolicyError extends Data.TaggedError("PolicyError")<{
  readonly message: string;
  /** The attribute or namespace ident the rule named, when there is one. */
  readonly ident?: string;
  readonly cause?: unknown;
}> {}
