import * as Data from "effect/Data";
import {
  InvalidRequest,
  OperationRejected,
  TxRejected,
  Unauthorized,
} from "../../db/Errors.ts";
import { TxError } from "../core/index.ts";

export { TxRejected };

export class TransactorDeadError extends Error {
  constructor(reason: string) {
    super(`transactor aborted: ${reason}`);
  }
}

export class TransactorDead extends Data.TaggedError("TransactorDead")<{ message: string; retryAfterMs: number }> {}
export class Unavailable extends Data.TaggedError("Unavailable")<{
  message: string;
  retryAfterMs: number;
}> {}
export class BadRequest extends Data.TaggedError("BadRequest")<{ message: string }> {}
export class NotFound extends Data.TaggedError("NotFound")<{ message: string }> {}
export class Internal extends Data.TaggedError("Internal")<{ message: string }> {}

export type TransactorHttpError =
  | TxRejected
  | Unauthorized
  | OperationRejected
  | TransactorDead
  | Unavailable
  | BadRequest
  | NotFound
  | Internal;

const TAGS = {
  TxRejected: 409,
  Unauthorized: 401,
  OperationRejected: 409,
  TransactorDead: 503,
  Unavailable: 503,
  BadRequest: 400,
  NotFound: 404,
  Internal: 500,
} as const;

export function toHttpError(err: unknown): TransactorHttpError {
  if (
    err instanceof TxRejected || err instanceof Unauthorized ||
    err instanceof OperationRejected || err instanceof TransactorDead ||
    err instanceof BadRequest || err instanceof NotFound || err instanceof Internal ||
    err instanceof Unavailable
  ) return err;
  if (err instanceof InvalidRequest) return new BadRequest({ message: err.message });
  if (err instanceof TxError) return new TxRejected({ message: err.message, code: err.code });
  if (err instanceof TransactorDeadError) return new TransactorDead({ message: err.message, retryAfterMs: 0 });
  return new Internal({ message: err instanceof Error ? err.message : String(err) });
}

export const statusOf = (e: TransactorHttpError): number =>
  e._tag === "Unauthorized" ? (e.status ?? 401) : TAGS[e._tag];

export function errorResponse(e: TransactorHttpError): Response {
  const body: Record<string, unknown> = { error: e.message, tag: e._tag, message: e.message };
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (e._tag === "TxRejected") {
    body.code = e.code;
    if (e.attr !== undefined) body.attr = e.attr;
  }
  if (e._tag === "TransactorDead" || e._tag === "Unavailable") {
    body.retryAfterMs = e.retryAfterMs;
    headers["retry-after"] = String(Math.ceil(e.retryAfterMs / 1000));
  }
  if (e._tag === "OperationRejected") {
    body.operation = e.operation;
    if (e.step !== undefined) body.step = e.step;
    if (e.reason !== undefined) body.reason = e.reason;
  }
  return new Response(JSON.stringify(body), { status: statusOf(e), headers });
}
