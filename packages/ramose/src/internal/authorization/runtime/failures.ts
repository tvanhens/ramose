/**
 * Tagged failures for JWT admission (AUTH-1).
 *
 * Messages are short reason tokens for internal diagnostics only.
 * They never carry token, JWKS, or jose text.
 *
 * @internal
 */

import * as Data from "effect/Data";

export class AuthenticationRejected extends Data.TaggedError("AuthenticationRejected")<{
  readonly message: string;
}> {}

export class JwksUnavailable extends Data.TaggedError("JwksUnavailable")<{
  readonly message: string;
}> {}

export type AuthenticationAdmissionFailure = AuthenticationRejected | JwksUnavailable;
