"use client";

/**
 * `useBasis` — where the database's basis is: `db.basis()` on mount, then
 * again on every wake of the db's session (a `{ op: "tx" }` / resync, a
 * local `transact`, a reconnect) — one `GET /db/:name/info` each. An
 * `asOf(t)` view answers `t` synchronously on the first render, with no
 * request; an HTTPS-only client has no session to wake, so the read is
 * one-shot. `undefined` until the first answer lands.
 */

import type { Catalog, ReadDb } from "../db/index.ts";
import * as Effect from "effect/Effect";
import { useEffect, useState } from "react";
import { seamOf, viewDep } from "./seam.ts";

export const useBasis = <C extends Catalog.Any>(
  db: ReadDb<C>,
): number | undefined => {
  const view = viewDep(db);
  const [t, setT] = useState<number | undefined>(() => seamOf(db)?.asOf);

  useEffect(() => {
    const pinned = seamOf(db)?.asOf;
    if (pinned !== undefined) {
      // a pinned view's basis is its coordinate: no request, nothing to tick
      setT(pinned);
      return;
    }

    let disposed = false;
    let landed: number | undefined;
    // last-write-wins by issue order: a slower `/info` from before a tick
    // must not overwrite the answer the tick's re-read already landed
    const runs = { issued: 0, applied: 0 };
    const read = (): void => {
      const seq = ++runs.issued;
      const land = (value: number | undefined): void => {
        if (disposed || seq < runs.applied) return;
        runs.applied = seq;
        landed = value;
        setT(value);
      };
      Effect.runFork(
        db.basis().pipe(
          Effect.flatMap((basis) => Effect.sync(() => land(basis.t))),
          Effect.catchCause(() => Effect.sync(() => land(undefined))),
        ),
      );
    };

    read();
    // observing the basis bumps the session, so the mount's own `/info`
    // wakes this subscriber back; defer a microtask (the read has landed by
    // then) and skip any wake that carries nothing newer than what landed
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
    // structural: `db.asOf(t)` built inline must not re-poll per render
  }, [view]);

  return t;
};
