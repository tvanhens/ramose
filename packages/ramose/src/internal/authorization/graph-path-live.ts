/**
 * Graph-path composition for the shared leased-live output gate (#327).
 *
 * This module does not authorize path segments itself. Every lease reruns the
 * complete #325 filtered-Db traversal, then hands only the target filtered Db
 * to the same #415 recompute/enqueue/emission engine as an ordinary live read.
 */

import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unauthorized } from "../../db/Errors.ts";
import {
  graphPathLeaseDependsOn,
  graphPathLeaseIdentity,
  opaqueGraphPathDenial,
  resolveAuthorizedGraphPath,
  sameGraphPathLeaseIdentity,
  type ExecuteAuthorizedGraphPathInput,
  type GraphPathLeaseDependency,
  type GraphPathLeaseIdentity,
} from "./graph-path.ts";
import {
  executeAuthorizedLiveLease,
  type AuthorizedLiveControls,
  type LiveQueryDiff,
} from "./live.ts";
import type {
  OneShotRead,
  OneShotReadError,
  OneShotReadOptions,
} from "./reads.ts";

const deny = (): Unauthorized => new Unauthorized({ status: 403 });

export type AuthorizedGraphPathLiveInput<
  R = never,
  EDb = unknown,
  EProvision = unknown,
> = ExecuteAuthorizedGraphPathInput<R, EDb, EProvision> &
  Omit<AuthorizedLiveControls<R>, "invalidations"> & {
    /** Identity fixed by the initial, ordinary HTTP admission traversal. */
    readonly expectedLeaseIdentity: GraphPathLeaseIdentity;
    /** Optional optimization; complete bounded renewal remains authoritative. */
    readonly dependencyInvalidations?: Stream.Stream<
      GraphPathLeaseDependency,
      Unauthorized,
      R
    >;
  };

/**
 * Reauthorize every path segment for every lease and every wake. A path that
 * now resolves to another entity/database/catalog unit closes uniformly; a
 * live lease never migrates to that new target.
 */
export const executeAuthorizedGraphPathLive = <
  R,
  EDb = unknown,
  EProvision = unknown,
>(
  input: AuthorizedGraphPathLiveInput<R, EDb, EProvision>,
  read: OneShotRead,
  opts: OneShotReadOptions = {},
): Stream.Stream<
  LiveQueryDiff,
  Unauthorized | OneShotReadError | EDb | EProvision,
  R
> => {
  const invalidations = input.dependencyInvalidations?.pipe(
    Stream.filter((dependency) =>
      graphPathLeaseDependsOn(input.expectedLeaseIdentity, dependency)
    ),
  );
  return executeAuthorizedLiveLease({
    ...input,
    reauthorizeOnIdle: true,
    ...(invalidations === undefined ? {} : { invalidations }),
    authorize: (caller) =>
      resolveAuthorizedGraphPath(input, caller).pipe(
        Effect.mapError(opaqueGraphPathDenial),
        Effect.flatMap((target) =>
          sameGraphPathLeaseIdentity(
              input.expectedLeaseIdentity,
              graphPathLeaseIdentity(target, input.path),
            )
            ? Effect.succeed(target.context.filteredDb)
            : Effect.fail(deny())
        ),
      ),
  }, read, opts);
};
