"use client";

/**
 * `useConnectionStatus` — `"connecting" | "live" | "reconnecting" |
 * "offline" | "closed"`, from the session the client already tracks.
 *
 * Provider-scoped (`useConnectionStatus()`) rolls up every session the
 * nearest client has opened. Per-db (`useConnectionStatus(db)`) reads
 * that database's session and needs no provider — the same rule as
 * `useLiveQuery(db, q)`.
 */

import type { ConnectionStatus, Schema, ReadDb } from "../db/index.ts";
import { useContext, useEffect, useState } from "react";
import { RamoseContext } from "./context.ts";
import { seamOf, viewDep } from "./seam.ts";

const overlayOffline = (status: ConnectionStatus): ConnectionStatus => {
  if (status === "closed") return status;
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return "offline";
  }
  return status;
};

/** Provider-scoped: the nearest client's rolled-up status. */
export function useConnectionStatus(): ConnectionStatus;
/** Per-db: that database's session. Needs no provider. */
export function useConnectionStatus<C extends Schema.Any>(
  db: ReadDb<C>,
): ConnectionStatus;
export function useConnectionStatus(db?: ReadDb): ConnectionStatus {
  const ctx = useContext(RamoseContext);
  const client = ctx?.client ?? null;
  if (db === undefined && client === null) {
    throw new Error(
      "useConnectionStatus: no <RamoseProvider> above this component. " +
        "Wrap your tree in <RamoseProvider url={…}> from \"ramose/react\" " +
        "or pass a db.",
    );
  }
  const view = db === undefined ? undefined : viewDep(db);

  const read = (): ConnectionStatus => {
    if (db !== undefined) {
      const seam = seamOf(db);
      return overlayOffline(seam?.status() ?? "offline");
    }
    return overlayOffline(client!.connectionStatus());
  };

  const [status, setStatus] = useState(read);

  useEffect(() => {
    let disposed = false;
    const sync = (): void => {
      if (!disposed) setStatus(read());
    };
    sync();

    const offs: Array<() => void> = [];
    if (db !== undefined) {
      const off = seamOf(db)?.onWake(sync);
      if (off !== undefined) offs.push(off);
    } else if (client !== null) {
      offs.push(client.onConnectionStatus(sync));
    }
    if (typeof window !== "undefined") {
      window.addEventListener("online", sync);
      window.addEventListener("offline", sync);
      offs.push(() => {
        window.removeEventListener("online", sync);
        window.removeEventListener("offline", sync);
      });
    }

    return () => {
      disposed = true;
      for (const off of offs) off();
    };
    // read closes over db / client; view is the structural db identity
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, view]);

  return status;
}
