/**
 * `db.run` — decode input, run the optimistic prefix, queue the invocation.
 */

import * as Effect from "effect/Effect";
import type { AnySchema } from "./Schema.ts";
import type { Db, Wire } from "./Db.ts";
import { makeEid } from "./Eid.ts";
import { type DbError, InvalidRequest } from "./Errors.ts";
import { record } from "./http.ts";
import {
  type AnyOperation,
  decodeInput,
  decodeOutput,
  type OpPrincipal,
  type OpReport,
  type OperationInvocation,
  lowerEntityArg,
  materializeOutput,
} from "./Operation.ts";

export interface OverlayOpAck {
  readonly t: number;
  readonly txEid: number;
  readonly datomCount: number;
  readonly output: unknown;
  readonly clientOpId: string;
}

interface RunView {
  readonly asOf?: number;
  readonly history?: boolean;
  readonly minT?: number;
}

const newClientOpId = (): string =>
  typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `c${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

const asPrincipal = (
  p: { readonly eid: number | null; readonly class: string },
): OpPrincipal => ({
  eid: p.eid,
  class: p.class,
  claims: {},
});

const reportOf = <C extends AnySchema, O>(
  wire: Wire,
  name: string,
  schema: C,
  view: RunView,
  ack: {
    readonly t: number;
    readonly txEid: number;
    readonly datomCount: number;
    readonly output: O;
  },
  make: (wire: Wire, name: string, schema: C, view: RunView) => Db<C>,
): OpReport<O, C> => ({
  t: ack.t,
  txEid: makeEid<C>(ack.txEid),
  datomCount: ack.datomCount,
  output: ack.output,
  dbAfter: make(wire, name, schema, view),
});

export const runOperation = <C extends AnySchema, O>(
  wire: Wire,
  name: string,
  schema: C,
  view: RunView,
  bad: InvalidRequest | undefined,
  operation: AnyOperation,
  entityArg: unknown,
  inputArg: unknown,
  make: (wire: Wire, name: string, schema: C, view: RunView) => Db<C>,
): Effect.Effect<OpReport<O, C>, DbError> => {
  if (bad !== undefined) return Effect.fail(bad);
  return Effect.gen(function* () {
    if (operation.on !== undefined && entityArg === undefined) {
      return yield* new InvalidRequest({
        message: `operation ${operation.name} is contextual and needs an entity`,
      });
    }
    const input = yield* decodeInput(operation.input, inputArg);
    const entity = operation.on !== undefined ? lowerEntityArg(entityArg) : undefined;
    const clientOpId = newClientOpId();
    const invocation: OperationInvocation = {
      name: operation.name,
      ...(entity !== undefined ? { entity } : {}),
      input,
      clientOpId,
    };

    const overlay = wire.overlay?.(name);
    if (overlay?.run !== undefined) {
      const who = yield* wire.principal(name);
      const ack = yield* overlay.run({
        invocation,
        operation,
        schema,
        principal: asPrincipal(who),
        db: name,
      });
      const output = yield* decodeOutput<O>(operation.output, ack.output);
      return reportOf<C, O>(
        wire,
        name,
        schema,
        view,
        { ...ack, output },
        make,
      );
    }

    const body = yield* wire.operation(name, invocation);
    const ack = record(body);
    const t = typeof ack.t === "number" ? ack.t : 0;
    wire.session(name)?.bump(t);
    const tempids =
      ack.tempids !== null && typeof ack.tempids === "object"
        ? (ack.tempids as Record<string, number>)
        : {};
    const output = yield* decodeOutput<O>(
      operation.output,
      materializeOutput(ack.output, tempids),
    );
    return reportOf<C, O>(
      wire,
      name,
      schema,
      { ...view, minT: t },
      {
        t,
        txEid: typeof ack.txEid === "number" ? ack.txEid : 0,
        datomCount: Array.isArray(ack.datoms)
          ? ack.datoms.length
          : typeof ack.datoms === "number"
            ? ack.datoms
            : 0,
        output,
      },
      make,
    );
  });
};
