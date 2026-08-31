/**
 * - `idle` — nothing has been observed yet, so nothing synchronizes. This is
 *   what a freshly constructed client reports; constructing handles is inert.
 * - `connecting` — an activation is in flight and no local value is readable.
 * - `live` — a local value is readable and the server has confirmed it.
 * - `stale` — a local value is readable but the current session has not
 *   confirmed it: a restored offline replica, or a reconnect in progress.
 * - `offline` — the activation could not reach the server. Whatever local value
 *   was already confirmed stays readable; nothing new is. Not a terminal state:
 *   the next time the tab is activated — focused, shown, restored from the
 *   back/forward cache, or told the device is online — it activates again.
 * - `update-required` — this client build is behind, and no retry helps; ship a
 *   new build. Two causes, and they differ in what stays readable. The server
 *   rotated the authorized view (a schema, trait, read-policy, or graph-read
 *   change): nothing is published, because this build cannot read what the
 *   server now serves. Or this build cannot replay its own durable queued work
 *   — a record, an acknowledgement or an allocation it cannot read or apply:
 *   that work is withheld, but the committed replica is untouched and stays
 *   readable, so queries keep answering from it without the pending work folded
 *   in. Nothing queued is discarded either way.
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

const SEVERITY: readonly SyncStatus[] = Object.freeze([
  "closed",
  "update-required",
  "authentication-required",
  "offline",
  "connecting",
  "stale",
  "live",
]);

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
