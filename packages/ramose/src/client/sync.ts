/**
 * The synchronization state one client (or one of its databases) is in.
 *
 * Deliberately coarse and deliberately opaque: it says what an application can
 * do right now, never how the protocol got there. Revisions, coverage,
 * transport frames, and physical database names are not public API, so nothing
 * here can carry one.
 */

/**
 * - `idle` — nothing has been observed yet, so nothing synchronizes. This is
 *   what a freshly constructed client reports; constructing handles is inert.
 * - `connecting` — an activation is in flight and no local value is readable.
 * - `live` — a local value is readable and the server has confirmed it.
 * - `stale` — a local value is readable but the current session has not
 *   confirmed it: a restored offline replica, or a reconnect in progress.
 * - `offline` — the activation could not reach the server. Whatever local value
 *   was already confirmed stays readable; nothing new is.
 * - `update-required` — this client build cannot read the server's current
 *   authorized view (schema, trait, read-policy, or graph-read change), or
 *   cannot replay its own durable optimistic layers. No data is published and
 *   no retry helps; ship a new build.
 * - `authentication-required` — the credential was refused, or the principal
 *   behind it was replaced. There is no anonymous fallback and no other
 *   candidate: the prior partition is fenced and publishes nothing.
 * - `closed` — `close()` or `clearLocalData()` made this client terminal.
 */
export type SyncStatus =
  | "idle"
  | "connecting"
  | "live"
  | "stale"
  | "offline"
  | "update-required"
  | "authentication-required"
  | "closed";

/**
 * One published synchronization state.
 *
 * A frozen singleton per status, so `getSnapshot()` identity changes exactly
 * when the status does and an adapter can compare with `===`.
 */
export type SyncState = {
  readonly status: SyncStatus;
};

const STATES: Readonly<Record<SyncStatus, SyncState>> = Object.freeze({
  idle: Object.freeze({ status: "idle" as const }),
  connecting: Object.freeze({ status: "connecting" as const }),
  live: Object.freeze({ status: "live" as const }),
  stale: Object.freeze({ status: "stale" as const }),
  offline: Object.freeze({ status: "offline" as const }),
  "update-required": Object.freeze({ status: "update-required" as const }),
  "authentication-required": Object.freeze({
    status: "authentication-required" as const,
  }),
  closed: Object.freeze({ status: "closed" as const }),
});

export const syncState = (status: SyncStatus): SyncState => STATES[status];

/**
 * Severity order for the per-client aggregate, most severe first.
 *
 * A client is only as synchronized as its least synchronized activated
 * database: one database that cannot be read at all is the fact an application
 * has to react to, and a `live` sibling does not soften it. `closed` leads
 * because a database whose session was closed under it is terminal — nothing
 * reactivates it, so reporting the client as healthy would be a lie. `idle` is
 * absent because it describes the *absence* of activations rather than one.
 */
const SEVERITY: readonly SyncStatus[] = Object.freeze([
  "closed",
  "update-required",
  "authentication-required",
  "offline",
  "connecting",
  "stale",
  "live",
]);

/** The aggregate of every activated database, or `idle` when there are none. */
export const aggregateSyncStatus = (
  statuses: Iterable<SyncStatus>,
): SyncStatus => {
  let worst: number | undefined;
  for (const status of statuses) {
    const rank = SEVERITY.indexOf(status);
    if (rank === -1) continue;
    if (worst === undefined || rank < worst) worst = rank;
  }
  return worst === undefined ? "idle" : SEVERITY[worst]!;
};
