/**
 * One-shot application reads against the filtered {@link Db} from
 * {@link executeAuthorizedRequest}. Query, pull, entity, lookup, and
 * graph/trait/aggregation shapes are ordinary engine APIs — there is no
 * authorization-specific planner or result-shaping branch.
 */

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { EntityRef } from "../core/db.ts";
import type { Db } from "../core/db.ts";
import { query, type QueryOptions } from "../core/query/engine.ts";
import { pull } from "../core/query/pull.ts";
import {
  executeAuthorizedRequest,
  type AuthorizedRequestInput,
} from "./request.ts";

/** Thrown query/pull/entity failure, wrapped so Effect keeps a tagged channel. */
export class OneShotReadError extends Data.TaggedError("OneShotReadError")<{
  readonly cause: unknown;
}> {}

export type OneShotQueryRead = {
  readonly kind: "query";
  readonly query: string | object;
  readonly inputs?: readonly unknown[];
};

export type OneShotPullRead = {
  readonly kind: "pull";
  readonly eid: EntityRef;
  readonly pattern: string | unknown[];
};

export type OneShotEntityRead = {
  readonly kind: "entity";
  readonly ref: EntityRef;
};

export type OneShotLookupRead = {
  readonly kind: "lookup";
  readonly ref: readonly [string, unknown];
};

/** External one-shot read shapes. Graph, trait, aggregation, sort, and
 *  limit are query bodies; they do not get a second authorization path. */
export type OneShotRead =
  | OneShotQueryRead
  | OneShotPullRead
  | OneShotEntityRead
  | OneShotLookupRead;

export type OneShotReadOptions = Pick<QueryOptions, "maxCells">;

const resolveEid = (db: Db, ref: EntityRef): Promise<number | undefined> =>
  typeof ref === "number" ? Promise.resolve(ref) : db.entid(ref);

/**
 * Ordinary query / pull / entity / lookup against the supplied database
 * value. The caller must pass the filtered request `Db`; this function
 * does not consult policy, principals, or an unfiltered snapshot.
 */
export const runOneShotRead = async (
  db: Db,
  read: OneShotRead,
  opts: OneShotReadOptions = {},
): Promise<unknown> => {
  switch (read.kind) {
    case "query":
      return query(db, read.query, read.inputs === undefined ? [] : [...read.inputs], {
        ...(opts.maxCells === undefined ? {} : { maxCells: opts.maxCells }),
      });
    case "pull": {
      const eid = await resolveEid(db, read.eid);
      if (eid === undefined) return null;
      return pull(db, eid, read.pattern);
    }
    case "entity": {
      const eid = await resolveEid(db, read.ref);
      if (eid === undefined) return null;
      return (await db.entity(eid)) ?? null;
    }
    case "lookup":
      return (await db.entid([read.ref[0], read.ref[1]])) ?? null;
  }
};

/**
 * Construct the request {@link Db}, then run one ordinary read against
 * only that value. Same constructor, same filtered database, every shape.
 */
export const executeAuthorizedRead = <R, EDb = unknown>(
  input: AuthorizedRequestInput<R, EDb>,
  read: OneShotRead,
  opts: OneShotReadOptions = {},
) =>
  executeAuthorizedRequest(input, (filteredDb) =>
    Effect.tryPromise({
      try: () => runOneShotRead(filteredDb, read, opts),
      catch: (cause) => new OneShotReadError({ cause }),
    }),
  );
