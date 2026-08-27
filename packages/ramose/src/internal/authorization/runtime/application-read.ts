/**
 * Application query and pull (TCB-1, TCB-3, CUR-1).
 *
 * These entry points accept only {@link AuthorizedSnapshot}. They must
 * not obtain raw or rule services from their environment. Core engine
 * `query(db)` / `pull(db)` remain storage-internal tests of the Datalog
 * executor — they are not the external application path.
 *
 * Until the authorized datom cursor lands (#367), a live authorized
 * snapshot yields no application datoms (FC-2).
 *
 * @internal
 */

import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type { ApplicationSnapshotFailure } from "./failures.ts";
import { SnapshotCancelled } from "./failures.ts";
import {
  checkAuthorizedSnapshot,
  type AuthorizedSnapshot,
  type RawSnapshot,
  type RuleSnapshot,
} from "./snapshots.ts";

export type ApplicationReadFailure = ApplicationSnapshotFailure;

const requireAuthorized = (
  snapshot: AuthorizedSnapshot,
): Effect.Effect<void, ApplicationReadFailure> => {
  const checked = checkAuthorizedSnapshot(snapshot);
  if (Result.isFailure(checked)) return Effect.fail(checked.failure);
  return Effect.void;
};

/**
 * External application query. Only an authorized snapshot is accepted.
 * Result is empty until #367 filters principal-visible datoms.
 */
export const queryAuthorized = (
  snapshot: AuthorizedSnapshot,
  _query: unknown,
  _inputs?: readonly unknown[],
): Effect.Effect<readonly unknown[], ApplicationReadFailure> =>
  requireAuthorized(snapshot).pipe(Effect.as([]));

/**
 * External application pull. Only an authorized snapshot is accepted.
 * Result is null until #367 filters principal-visible datoms.
 */
export const pullAuthorized = (
  snapshot: AuthorizedSnapshot,
  _eid: number,
  _pattern: unknown,
): Effect.Effect<null, ApplicationReadFailure> =>
  requireAuthorized(snapshot).pipe(Effect.as(null));

/** Type-level witness: raw snapshots are not application query inputs. */
export type RejectRawQuery = RawSnapshot extends Parameters<typeof queryAuthorized>[0]
  ? never
  : true;

/** Type-level witness: rule snapshots are not application query inputs. */
export type RejectRuleQuery = RuleSnapshot extends Parameters<typeof queryAuthorized>[0]
  ? never
  : true;

/** Type-level witness: raw snapshots are not application pull inputs. */
export type RejectRawPull = RawSnapshot extends Parameters<typeof pullAuthorized>[0]
  ? never
  : true;

/** Type-level witness: rule snapshots are not application pull inputs. */
export type RejectRulePull = RuleSnapshot extends Parameters<typeof pullAuthorized>[0]
  ? never
  : true;

export const cancelledAuthorizedRead = new SnapshotCancelled({
  message: "authorized snapshot is not a live capability",
});
