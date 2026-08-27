/**
 * Immutable verified-principal value. Token material is never stored.
 *
 * @internal
 */

import * as Result from "effect/Result";
import type { JsonValue } from "../json.ts";
import type { AuthorizationPrincipal } from "../principal.ts";
import { AuthenticationRejected } from "./failures.ts";

export const ATTRS_MAX_DEPTH = 256;
export const ATTRS_MAX_NODES = 4096;

export interface VerifiedClaims {
  readonly sub: string;
  readonly iss: string;
  readonly aud: string;
  readonly exp: number;
  readonly iat?: number;
  readonly nbf?: number;
  readonly attrs?: Readonly<Record<string, unknown>>;
}

export interface VerifiedPrincipal {
  readonly subject: string;
  readonly database: string;
  readonly classes: readonly string[];
  readonly claims: VerifiedClaims;
  readonly expiresAt: number;
}

const freeze = <T>(value: T): T => Object.freeze(value);

const claimsRejected = () => new AuthenticationRejected({ message: "claims" });

const freezeJsonBounded = <T>(value: T): Result.Result<T, AuthenticationRejected> => {
  if (value === null || typeof value !== "object") return Result.succeed(value);

  type Job = { readonly src: object; readonly dest: object; readonly depth: number };
  const rootDest: object = Array.isArray(value) ? [] : {};
  const stack: Job[] = [{ src: value, dest: rootDest, depth: 1 }];
  let nodes = 1;

  while (stack.length > 0) {
    const job = stack.pop()!;
    if (Array.isArray(job.src)) {
      const dest = job.dest as unknown[];
      for (let i = 0; i < job.src.length; i++) {
        const child = job.src[i];
        if (child === null || typeof child !== "object") {
          dest[i] = child;
          continue;
        }
        nodes += 1;
        if (nodes > ATTRS_MAX_NODES || job.depth + 1 > ATTRS_MAX_DEPTH) {
          return Result.fail(claimsRejected());
        }
        const childDest: object = Array.isArray(child) ? [] : {};
        dest[i] = childDest;
        stack.push({ src: child, dest: childDest, depth: job.depth + 1 });
      }
    } else {
      const dest = job.dest as Record<string, unknown>;
      for (const [key, child] of Object.entries(job.src)) {
        if (child === null || typeof child !== "object") {
          dest[key] = child;
          continue;
        }
        nodes += 1;
        if (nodes > ATTRS_MAX_NODES || job.depth + 1 > ATTRS_MAX_DEPTH) {
          return Result.fail(claimsRejected());
        }
        const childDest: object = Array.isArray(child) ? [] : {};
        dest[key] = childDest;
        stack.push({ src: child, dest: childDest, depth: job.depth + 1 });
      }
    }
    freeze(job.dest);
  }

  return Result.succeed(rootDest as T);
};

const freezeJson = <T>(value: T): Result.Result<T, AuthenticationRejected> =>
  Result.flatMap(
    Result.try({
      try: () => freezeJsonBounded(value),
      catch: claimsRejected,
    }),
    (inner) => inner,
  );

export const makeVerifiedPrincipal = (input: {
  readonly subject: string;
  readonly database: string;
  readonly className: string;
  readonly iss: string;
  readonly aud: string;
  readonly exp: number;
  readonly iat?: number | undefined;
  readonly nbf?: number | undefined;
  readonly attrs?: Readonly<Record<string, unknown>> | undefined;
}): Result.Result<VerifiedPrincipal, AuthenticationRejected> =>
  Result.flatMap(
    input.attrs === undefined
      ? Result.succeed(undefined)
      : Result.flatMap(
          Result.try({
            try: () => ({ ...input.attrs }),
            catch: claimsRejected,
          }),
          freezeJson,
        ),
    (attrs) =>
      Result.try({
        try: () =>
          freeze({
            subject: input.subject,
            database: input.database,
            classes: freeze([input.className]),
            claims: freeze({
              sub: input.subject,
              iss: input.iss,
              aud: input.aud,
              exp: input.exp,
              ...(input.iat === undefined ? {} : { iat: input.iat }),
              ...(input.nbf === undefined ? {} : { nbf: input.nbf }),
              ...(attrs === undefined ? {} : { attrs }),
            }),
            expiresAt: input.exp * 1000,
          }),
        catch: claimsRejected,
      }),
  );

/** Catalog resolves `me` later. */
export const toAuthorizationPrincipal = (p: VerifiedPrincipal): AuthorizationPrincipal => ({
  subject: p.subject,
  claims: { ...p.claims } as { readonly [key: string]: JsonValue },
  classes: [...p.classes],
});
