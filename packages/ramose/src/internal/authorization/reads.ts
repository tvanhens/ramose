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

export type OneShotRead =
  | OneShotQueryRead
  | OneShotPullRead
  | OneShotEntityRead
  | OneShotLookupRead;

export type OneShotReadOptions = Pick<QueryOptions, "maxCells">;

const resolveEid = (db: Db, ref: EntityRef): Promise<number | undefined> =>
  typeof ref === "number" ? Promise.resolve(ref) : db.entid(ref);

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
