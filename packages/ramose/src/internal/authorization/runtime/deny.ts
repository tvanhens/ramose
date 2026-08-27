/**
 * One outer deny/close boundary (FC-1, FC-2).
 *
 * Missing services, incomplete wiring, and inner capability failures
 * all become payload-free {@link AuthorizationDenied}. Do not scatter
 * `catchAll(() => Deny)` through callers — route through here.
 *
 * @internal
 */

import * as Effect from "effect/Effect";
import { AuthorizationDenied } from "../failures.ts";

const DENIED = new AuthorizationDenied();

/** Drop any inner failure and fail closed. Never reveals existence. */
export const toAuthorizationDenied = <A = never>(
  _internal?: unknown,
): Effect.Effect<A, AuthorizationDenied> => Effect.fail(DENIED);

/** The configured-database close. Application access until #339/#343/#344. */
export const closeConfiguredAccess: Effect.Effect<never, AuthorizationDenied> =
  Effect.fail(DENIED);
