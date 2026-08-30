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

export interface AuthConfig {
  readonly issuer: string;
  readonly audience: string;
  readonly ttl: number;
}

/** The subject-and-class half of a claim set; {@link AuthConfig} is the rest. */
export interface ClaimsInput {
  readonly sub: string;
  readonly class: string;
  readonly attrs?: Readonly<Record<string, unknown>> | undefined;
  readonly now?: Date | undefined;
}

/** Declared class vocabulary used to reject undeclared mint classes. */
export type ClaimsPolicy = { readonly classes: readonly string[] };

const declaredClasses = (policy: ClaimsPolicy): readonly string[] =>
  policy.classes.filter((c): c is string => typeof c === "string");

/**
 * Build the claim set the peer verifies. Pure: no signing, no I/O.
 *
 * Validates at mint what the peer would reject anyway: when a compiled
 * policy is given, `class` must be one the policy declares, because an
 * undeclared class grants nothing, never an outage. `exp - iat` is exactly
 * `auth.ttl`. JWT identity is deployment-global — do not emit `ramose.db`.
 *
 * @example
 * ```typescript
 * const payload = Ramose.claims(
 *   AUTH,
 *   { sub: user.id, class: role },
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
  if (!Number.isInteger(auth.ttl) || auth.ttl <= 0) {
    throw new InvalidRequest({
      message: `ramose: auth.ttl must be a positive whole number of seconds, got ${auth.ttl}`,
    });
  }
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
      class: input.class,
      ...(input.attrs === undefined ? {} : { attrs: input.attrs }),
    },
  };
}
