/** Entity id wrapper — `.pull(...)` lives here, not on `db`. */

import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import type { QueryOptions } from "../Client.ts";
import type { DatabaseError } from "../DatabaseTypes.ts";
import type { AnyCatalog } from "./Catalog.ts";
import { noPeer, type MissingPeer } from "./Errors.ts";
import {
  lowerPullPattern,
  reshapePullResult,
  type IdentPullPattern,
  type PullResult,
  type ValidatePull,
} from "./Pull.ts";

export type EidPull = (
  id: number,
  pattern: unknown[],
  options?: QueryOptions,
) => Effect.Effect<unknown, DatabaseError, RuntimeContext>;

export type EidPullError = DatabaseError | MissingPeer;

export interface Eid<C extends AnyCatalog = AnyCatalog> {
  readonly _tag: "Eid";
  readonly id: number;
  readonly catalog: C;
  /**
   * Literate pull map, or ident-keyed array as the escape.
   * `options.minT` is the read fence — pass the `t` of your last transact to
   * read your own writes.
   */
  pull<const P>(
    pattern: [P] extends [readonly unknown[]]
      ? P & IdentPullPattern<C>
      : ValidatePull<C, P>,
    options?: QueryOptions,
  ): Effect.Effect<PullResult<C, P> | null, EidPullError, RuntimeContext>;
}

export const makeEid = <C extends AnyCatalog>(
  catalog: C,
  id: number,
  pullFn?: EidPull,
): Eid<C> => ({
  _tag: "Eid",
  id,
  catalog,
  pull: ((pattern: unknown, options?: QueryOptions) => {
    if (!pullFn) return noPeer("pull");
    const wire = lowerPullPattern(pattern);
    return pullFn(id, wire, options).pipe(
      Effect.map((result) => reshapePullResult(pattern, result)),
    );
  }) as Eid<C>["pull"],
});

export const isEid = (value: unknown): value is Eid =>
  typeof value === "object" &&
  value !== null &&
  (value as { _tag?: unknown })._tag === "Eid" &&
  "id" in value &&
  "pull" in value;

/**
 * Wrap a known eid. Query `find` already returns wrappers with a peer.
 * `Eid.of(catalog, id)` without `pullFn` is for type fixtures — `.pull`
 * fails with {@link MissingPeer}.
 */
export const Eid = {
  of: <C extends AnyCatalog>(
    catalog: C,
    id: number,
    pullFn?: EidPull,
  ): Eid<C> => makeEid(catalog, id, pullFn),
};
