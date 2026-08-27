/**
 * The verifier/minter contract, declared once on the deploy side.
 *
 * Ramose verifies JWTs and never issues them — but the *shape* it verifies
 * (https://ramose.ai/guides/sign-in/) is a contract with two consumers: the peer's env
 * (`Server({ auth: { jwt } })` pins `RAMOSE_JWT_ISS` / `RAMOSE_JWT_AUD` /
 * `RAMOSE_JWT_MAX_TTL`) and the app's mint route (which signs the payload).
 * `AuthConfig` is that contract as one value; {@link claims} builds the
 * payload from it, so the minted lifetime equals the verifier's cap by
 * construction and a claim set the peer would reject fails at mint instead.
 *
 * `claims` is pure — no signing, no I/O. The app signs the payload with
 * whatever it has (Better Auth's `auth.api.signJWT`, `jose`, …).
 */

import { DATABASE_NAME_RE, invalidDatabaseName } from "./db/DatabaseName.ts";
import { InvalidRequest } from "./db/Errors.ts";
export interface Claims {
  readonly iss?: string;
  readonly aud?: string | readonly string[];
  readonly sub?: string;
  readonly iat?: number;
  readonly exp?: number;
  readonly ramose?: {
    readonly db?: string;
    readonly class?: string;
    readonly attrs?: Readonly<Record<string, unknown>>;
  };
  readonly [claim: string]: unknown;
}

/** Cap on a token's lifetime when `RAMOSE_JWT_MAX_TTL` is unset, in seconds. */
export const DEFAULT_JWT_MAX_TTL = 900;

/**
 * The pinned verifier/minter contract. Declare once; hand it to
 * `Server({ auth: { jwt } })` and to {@link claims}.
 */
export interface AuthConfig {
  /** The `iss` every token carries and the peer pins (`RAMOSE_JWT_ISS`). */
  readonly issuer: string;
  /** The `aud` every token carries and the peer pins (`RAMOSE_JWT_AUD`). */
  readonly audience: string;
  /**
   * Token lifetime, in whole seconds (JWT NumericDate). Server pins
   * `RAMOSE_JWT_MAX_TTL` to it; `claims` sets `exp = iat + ttl` — so the cap
   * holds by construction.
   */
  readonly ttl: number;
}

/** The subject-and-scope half of a claim set; {@link AuthConfig} is the rest. */
export interface ClaimsInput {
  /** The principal — resolved by the policy's `principal` attribute. */
  readonly sub: string;
  /** The one database this token is bound to (`ramose.db`). */
  readonly db: string;
  /** The policy class this token selects (`ramose.class`). */
  readonly class: string;
  /** App claims (`ramose.attrs`), decoded by the policy's `claims` struct. */
  readonly attrs?: Readonly<Record<string, unknown>> | undefined;
  /** The mint instant; `iat` is this in whole seconds. @default new Date() */
  readonly now?: Date | undefined;
}

/** Declared class vocabulary used to reject undeclared mint classes. */
export type ClaimsPolicy = { readonly classes: readonly string[] };

const declaredClasses = (policy: ClaimsPolicy): readonly string[] =>
  policy.classes.filter((c): c is string => typeof c === "string");

/**
 * Build the claim set the peer verifies. Pure: no signing, no I/O.
 *
 * Validates at mint what the peer would reject anyway: `db` must be a valid
 * database name, and — when a compiled policy is given — `class` must be one
 * the policy declares, because an undeclared class grants nothing, never an
 * outage. `exp - iat` is exactly `auth.ttl`.
 *
 * @example
 * ```typescript
 * const payload = Ramose.claims(
 *   AUTH,
 *   { sub: user.id, db: workspace, class: role },
 *   { classes: ["member"] },
 * );
 * const { token } = await auth.api.signJWT({ body: { payload } });
 * ```
 */
export function claims<P extends ClaimsPolicy | undefined = undefined>(
  auth: AuthConfig,
  input: [P] extends [string | undefined]
    ? ClaimsInput
    : P extends { readonly classes: infer CL extends readonly string[] }
      ? Omit<ClaimsInput, "class"> & { readonly class: CL[number] }
      : ClaimsInput,
  policy?: P,
): Claims {
  // JWT NumericDate is whole seconds, so a fractional ttl would mint a
  // fractional `exp` — reject it rather than round it.
  if (!Number.isInteger(auth.ttl) || auth.ttl <= 0) {
    throw new InvalidRequest({
      message: `ramose: auth.ttl must be a positive whole number of seconds, got ${auth.ttl}`,
    });
  }
  if (!DATABASE_NAME_RE.test(input.db)) throw invalidDatabaseName(input.db);
  if (policy !== undefined) {
    const classes = declaredClasses(policy);
    if (!classes.includes(input.class)) {
      throw new InvalidRequest({
        message: `ramose: class ${JSON.stringify(input.class)} is not declared by the policy (classes: ${classes.join(", ")}) — an undeclared class grants nothing, so fail at mint`,
      });
    }
  }
  const iat = Math.floor((input.now ?? new Date()).getTime() / 1000);
  return {
    iss: auth.issuer,
    aud: auth.audience,
    sub: input.sub,
    iat,
    exp: iat + auth.ttl,
    ramose: {
      db: input.db,
      class: input.class,
      ...(input.attrs === undefined ? {} : { attrs: input.attrs }),
    },
  };
}
