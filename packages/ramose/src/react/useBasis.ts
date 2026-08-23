"use client";

/**
 * `useBasis` — where the database's basis is: `db.basis()` on mount, then
 * again on every wake of the db's session (a `{ op: "tx" }` / resync, a
 * local write, a reconnect) — one `GET /db/:name/info` each. An
 * `asOf(t)` view answers `t` synchronously on the first render, with no
 * request; an HTTPS-only client has no session to wake, so the read is
 * one-shot. `undefined` until the first answer lands.
 */

import type { Schema, ReadDb } from "../db/index.ts";
import { useEffect, useState } from "react";
import { seamOf, viewDep } from "./seam.ts";

export const useBasis = <C extends Schema.Any>(
  db: ReadDb<C>,
): number | undefined => {
  const view = viewDep(db);
  const [t, setT] = useState<number | undefined>(() => seamOf(db)?.asOf);

  useEffect(() => {
    const pinned = seamOf(db)?.asOf;
    if (pinned !== undefined) {
      setT(pinned);
      return;
    }

    let disposed = false;
    let landed: number | undefined;
    let inflight = false;
    let pendingWake = false;
    const runs = { issued: 0, applied: 0 };
    const read = (): void => {
      if (inflight) {
        pendingWake = true;
        return;
      }
      const seq = ++runs.issued;
      inflight = true;
      const land = (value: number | undefined): void => {
        if (disposed || seq < runs.applied) return;
        runs.applied = seq;
        landed = value;
        setT(value);
      };
      void db
        .basis()
        .then((basis) => land(basis.t))
        .catch(() => land(undefined))
        .finally(() => {
          inflight = false;
          if (pendingWake && !disposed) {
            pendingWake = false;
            read();
          }
        });
    };

    read();
    const off = seamOf(db)?.onWake(() => {
      queueMicrotask(() => {
        if (disposed) return;
        const seen = seamOf(db)?.t();
        if (seen !== undefined && landed !== undefined && seen <= landed) {
          return;
        }
        read();
      });
    });
    return () => {
      disposed = true;
      off?.();
    };
  }, [view]);

  return t;
};
