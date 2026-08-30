import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import { type VerifiedPrincipal } from "./auth.ts";
import { Unauthorized } from "./errors.ts";
import { JwtVerifier } from "./jwt.ts";

const unauthorized = (): Unauthorized => new Unauthorized({});

const bearer = (
  authorization: string | null,
): Result.Result<Redacted.Redacted<string>, Unauthorized> => {
  if (authorization === null) return Result.fail(unauthorized());
  const match = /^Bearer[ \t]+([^,\s]+)$/i.exec(authorization);
  return match === null
    ? Result.fail(unauthorized())
    : Result.succeed(Redacted.make(match[1]!));
};

const isWebSocketUpgrade = (request: Request): boolean =>
  request.headers.get("upgrade")?.trim().toLowerCase() === "websocket";

const isWebSocketSession = (request: Request, url: URL): boolean =>
  request.method === "GET" &&
  isWebSocketUpgrade(request) &&
  /^\/db\/[^/]+\/session$/.test(url.pathname);

export const requestCredential = (
  request: Request,
): Result.Result<Redacted.Redacted<string>, Unauthorized> => {
  const url = new URL(request.url);
  const authorization = request.headers.get("authorization");
  if (!isWebSocketSession(request, url)) {
    if (url.searchParams.has("token")) return Result.fail(unauthorized());
    return bearer(authorization);
  }

  if (authorization !== null) return bearer(authorization);
  const queryTokens = url.searchParams.getAll("token");
  if (
    queryTokens.length !== 1 ||
    queryTokens[0]!.length === 0 ||
    /\s/.test(queryTokens[0]!)
  ) {
    return Result.fail(unauthorized());
  }
  return Result.succeed(Redacted.make(queryTokens[0]!));
};

export const authenticateRequest = Effect.fn("authenticateRequest")(function* (
  request: Request,
): Effect.fn.Return<VerifiedPrincipal, Unauthorized, JwtVerifier> {
  const token = yield* Effect.fromResult(requestCredential(request));
  const verifier = yield* JwtVerifier;
  return yield* verifier.verify(token);
});
