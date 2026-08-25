"use client";

/**
 * `useBasis` — where the database's basis is. A live view reads
 * `session.t` synchronously and again on every session wake (a `{ op:
 * "tx" }` / resync, a local write, a reconnect) — no `GET /info` per
 * tick. An `asOf(t)` view answers `t` on the first render, with no
 * request. An HTTPS-only client has no session to wake: one `db.basis()`
 * so a useBasis-only tree still learns the peer's t. `undefined` until
 * the first answer lands.
 */

import type { Schema, ReadDb } from "../db/index.ts";
import { useEffect, useState } from "react";
import { readT } from "./read.ts";
import { seamOf, viewDep } from "./seam.ts";

export const useBasis = <C extends Schema.Any>(
  db: ReadDb<C>,
): number | undefined => {
  const view = viewDep(db);
  const [t, setT] = useState<number | undefined>(() => readT(db));

  useEffect(() => {
    const pinned = seamOf(db)?.asOf;
    if (pinned !== undefined) {
      setT(pinned);
      return;
    }

    let disposed = false;
    const sync = (): void => {
      if (!disposed) setT(readT(db));
    };
    sync();

    const off = seamOf(db)?.onWake(() => {
      queueMicrotask(sync);
    });

    // No session (HTTPS-only, or the socket is not open yet): one
    // authoritative `/info`. Later wakes — once a sibling opens the
    // session — still land through `onWake` + `session.t`.
    if (readT(db) === undefined) {
      void db
        .basis()
        .then((basis) => {
          if (!disposed) setT(basis.t);
        })
        .catch(() => {
          if (!disposed) setT(undefined);
        });
    }

    return () => {
      disposed = true;
      off?.();
    };
  }, [view]);

  return t;
};
