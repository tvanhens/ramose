/**
 * Server-side operation execution: resolve, decode, run the full body
 * (effects included), accumulate one transaction.
 */

import {
  type Datom,
  type Principal,
  Db as CoreDb,
  Index,
  Novelty,
  normalizePullPattern,
  processTx,
  pull as enginePull,
  query as engineQuery,
  toJson,
} from "../internal/core/index.ts";
import { type RamoseEnv, internalHeaders } from "../internal/transactor/index.ts";
import * as Effect from "effect/Effect";
import type { AnySchema } from "../db/Schema.ts";
import { schemaTx } from "../db/ensure.ts";
import {
  InternalError,
  InvalidRequest,
  isDatabaseError,
  NotOne,
  ParamError,
  type DbError,
} from "../db/Errors.ts";
import { buildOp, entityRefOf, runBody } from "../db/op-handle.ts";
import {
  type AnyOperation,
  type AnyOperations,
  decodeInput,
  encodeOutput,
  materializeOutput,
} from "../db/Operation.ts";
import { lowerPullPattern } from "../db/Pull.ts";
import { lowerQueryObject } from "../db/query/index.ts";
import { checkWrite, viewDb } from "./auth.ts";
import { BadRequest, OperationRejected } from "./errors.ts";
import { fetchBasisWithStats, invalidateBasis, segmentSource } from "./peer.ts";

export interface ServerOptions {
  readonly operations?: AnyOperations;
  readonly writes?: "all" | "operations";
}

export const lookupOperation = (
  registry: AnyOperations | undefined,
  name: string,
): AnyOperation | undefined => registry?.get(name);

const tagOf = (err: unknown): string | undefined =>
  typeof err === "object" &&
  err !== null &&
  "_tag" in err &&
  typeof err._tag === "string"
    ? err._tag
    : undefined;

const asQueryFailure = (cause: unknown): DbError => {
  if (isDatabaseError(cause)) return cause;
  if (cause instanceof NotOne || cause instanceof ParamError) {
    return new InvalidRequest({ message: cause.message });
  }
  return new InternalError({
    message: cause instanceof Error ? cause.message : String(cause),
  });
};

const overlayOn = (confirmed: CoreDb, extra: readonly Datom[]): CoreDb => {
  if (extra.length === 0) return confirmed;
  const nov = new Novelty();
  const avet = (a: number) => confirmed.schema.isAvet(a);
  const vaet = (a: number) => confirmed.schema.isVaet(a);
  nov.add(confirmed.novelty.byIndex[Index.EAVT].all(), avet, vaet);
  nov.add(extra, avet, vaet);
  let basisT = confirmed.basisT;
  for (const d of extra) if (d.t > basisT) basisT = d.t;
  return new CoreDb({
    store: confirmed.store,
    roots: confirmed.roots,
    novelty: nov,
    basisT,
    schema: confirmed.schema,
    nextEid: confirmed.nextEid,
  });
};

const withOps = async (base: CoreDb, ops: readonly unknown[]): Promise<CoreDb> => {
  if (ops.length === 0) return base;
  const expansion = await processTx(
    base,
    [...ops],
    base.basisT + 1,
    base.nextEid,
    Date.now(),
  );
  return overlayOn(base, expansion.datoms);
};

const entityNamespaceOk = async (
  db: CoreDb,
  eid: number,
  ns: string,
): Promise<"ok" | "dangling" | "foreign"> => {
  if (!(await db.exists(eid))) return "dangling";
  const row = await db.entity(eid);
  if (row === undefined) return "dangling";
  const keys = Object.keys(row).filter((k) => k !== ":db/id" && !k.startsWith(":db/"));
  if (keys.length === 0) return "dangling";
  const prefix = `:${ns}/`;
  return keys.some((k) => k.startsWith(prefix)) ? "ok" : "foreign";
};

const installOn = (
  env: RamoseEnv,
  db: string,
  schema: AnySchema,
  principal: Principal,
): Effect.Effect<unknown, InternalError> =>
  Effect.tryPromise({
    try: async () => {
      const stub = env.TRANSACTOR.get(env.TRANSACTOR.idFromName(db));
      const res = await stub.fetch(
        `https://transactor/transact?db=${encodeURIComponent(db)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json", ...internalHeaders(env) },
          body: JSON.stringify({ tx: toJson(schemaTx(schema)), principal }),
        },
      );
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `install failed: ${res.status}`);
      }
      invalidateBasis(db);
      return res.json();
    },
    catch: (cause) =>
      new InternalError({
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });

export interface ExecuteArgs {
  readonly env: RamoseEnv;
  readonly request: Request;
  readonly db: string;
  readonly principal: Principal;
  readonly registry: AnyOperations | undefined;
  readonly name: string;
  readonly entity: unknown;
  readonly input: unknown;
  readonly clientOpId?: string;
}

export interface ExecuteReady {
  readonly tx: unknown[];
  readonly output: unknown;
  readonly principal: Principal;
  readonly clientOpId?: string;
}

/**
 * Resolve, decode, validate the entity, run the full body. Effects run
 * here; accumulated tx ops are returned for the existing write pipeline.
 */
export async function prepareOperation(args: ExecuteArgs): Promise<ExecuteReady> {
  const operation = lookupOperation(args.registry, args.name);
  if (operation === undefined) {
    throw new BadRequest({ message: `unknown operation: ${args.name}` });
  }

  let decoded: unknown;
  try {
    decoded = await Effect.runPromise(decodeInput(operation.input, args.input));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new BadRequest({ message: msg || "invalid operation input" });
  }

  const bf = await fetchBasisWithStats(args.env, args.db, args.request);
  const store = segmentSource(args.env, args.db);
  const dbv = await viewDb(args.env, args.principal, store, bf.basis, {});

  let self: unknown;
  if (operation.on !== undefined) {
    const raw = args.entity;
    const eid =
      typeof raw === "number"
        ? raw
        : typeof raw === "object" &&
            raw !== null &&
            "id" in raw &&
            typeof raw.id === "number"
          ? raw.id
          : undefined;
    if (eid === undefined) {
      throw new OperationRejected({
        message: `operation ${operation.name} needs an entity`,
        operation: operation.name,
        reason: "dangling",
      });
    }
    const check = await entityNamespaceOk(dbv, eid, operation.on.ns);
    if (check !== "ok") {
      throw new OperationRejected({
        message:
          check === "dangling"
            ? `entity ${eid} does not exist`
            : `entity ${eid} is not a ${operation.on.ns}`,
        operation: operation.name,
        reason: check,
      });
    }
    self = eid;
  }

  let collected: () => readonly unknown[] = () => [];
  const built = buildOp({
    schema: { _tag: "Schema", entities: {} },
    db: args.db,
    principal: {
      eid: args.principal.eid ?? null,
      class: args.principal.class,
      sub: args.principal.sub,
      name:
        typeof args.principal.claims.attrs?.name === "string"
          ? args.principal.claims.attrs.name
          : undefined,
      claims: { ...args.principal.claims },
    },
    self,
    effects: "run",
    effectCtx: {
      env: args.env,
      databases: {
        install: (catalog, name) =>
          installOn(args.env, name ?? args.db, catalog, args.principal),
      },
    },
    q: (input, params) =>
      Effect.tryPromise({
        try: async () => {
          const lowered = lowerQueryObject(input, params);
          const db = await withOps(dbv, collected());
          const result = await engineQuery(db, lowered.query, []);
          const rows = lowered.finalize(result);
          if (rows instanceof NotOne || rows instanceof ParamError) throw rows;
          return rows;
        },
        catch: asQueryFailure,
      }),
    pull: (subject, pattern) =>
      Effect.tryPromise({
        try: async () => {
          const db = await withOps(dbv, collected());
          const normalized = normalizePullPattern(lowerPullPattern(pattern));
          const eid =
            typeof subject === "number"
              ? subject
              : await db.entid(entityRefOf(subject));
          if (eid === undefined) return null;
          return enginePull(db, eid, normalized);
        },
        catch: asQueryFailure,
      }),
  });
  collected = built.ops;

  let result: { output: unknown; halted: boolean };
  try {
    result = await Effect.runPromise(
      runBody(operation, built.op, decoded),
    );
  } catch (err) {
    const tag = tagOf(err);
    if (tag === "OperationRejected") throw err;
    throw new OperationRejected({
      message: err instanceof Error ? err.message : String(err),
      operation: operation.name,
      step: "body",
      reason: tag,
    });
  }

  let output: unknown = materializeOutput(result.output, {});
  try {
    output = await Effect.runPromise(
      encodeOutput(operation.output, output),
    );
  } catch {
    // keep the materialized value if the schema cannot encode handles
  }

  return {
    tx: [...built.ops()],
    output,
    principal: args.principal,
    clientOpId: args.clientOpId,
  };
}

export { checkWrite };
