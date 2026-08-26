/**
 * The one auditable fail-closed boundary.
 *
 * Typed failures and defects may be logged internally. None produce
 * application output. Do not scatter catchAll(() => Deny) at call sites.
 */

import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AuthorizationDenied, type AuthorizationFailure } from "./errors.ts";
import { False, type Truth } from "./truth.ts";

export interface FailClosedLog {
  readonly record: (event: {
    readonly _tag: "typed" | "defect";
    readonly failure?: AuthorizationFailure;
    readonly defect?: unknown;
  }) => void;
}

const silent: FailClosedLog = { record: () => undefined };

/** Map any authorization failure or defect to a deny. Nothing is returned to the app. */
export const failClosed = <A, R>(
  effect: Effect.Effect<A, AuthorizationFailure, R>,
  log: FailClosedLog = silent,
): Effect.Effect<A, AuthorizationDenied, R> =>
  effect.pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasDies(cause)) {
        log.record({ _tag: "defect", defect: Cause.squash(cause) });
      } else {
        const failure = Option.getOrUndefined(Cause.findErrorOption(cause));
        log.record({ _tag: "typed", failure });
      }
      return Effect.fail(
        new AuthorizationDenied({ message: "authorization denied" }),
      );
    }),
  );

/** Incomplete and False both deny. Used at the outer authorize boundary. */
export const closeTruth = (truth: Truth): boolean => truth._tag === "True";

export const deny: Truth = False;
