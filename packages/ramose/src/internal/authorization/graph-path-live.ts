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
    readonly expectedLeaseIdentity: GraphPathLeaseIdentity;
    readonly dependencyInvalidations?: Stream.Stream<
      GraphPathLeaseDependency,
      Unauthorized,
      R
    >;
  };

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
