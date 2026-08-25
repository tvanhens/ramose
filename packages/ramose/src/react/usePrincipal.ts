"use client";

/**
 * `usePrincipal(db)` — who this session is, as the peer reports it.
 *
 * `db.principal()` is already cached per session generation, so the hook
 * is thin: load on mount / view change, re-read when the session
 * generation advances (reconnect / new socket). `{ eid, class, loading }`
 * — `eid` is `null` until the principal row exists, `undefined` while
 * the first read is in flight.
 */

import type { Schema, Db, DbError, Eid } from "../db/index.ts";
import { useEffect, useRef, useState } from "react";
import { seamOf, viewDep } from "./seam.ts";

export interface Principal<C extends Schema.Any = Schema.Any> {
  /** Catalog-branded eid, or `null` when the principal row does not exist yet. */
  readonly eid: Eid<C> | null | undefined;
  readonly class: string | undefined;
  readonly loading: boolean;
}

export const usePrincipal = <C extends Schema.Any>(
  db: Db<C>,
  options?: { onError?: (error: DbError) => void },
): Principal<C> => {
  const view = viewDep(db);
  const [state, setState] = useState<Principal<C>>({
    eid: undefined,
    class: undefined,
    loading: true,
  });

  const onErrorRef = useRef(options?.onError);
  onErrorRef.current = options?.onError;

  useEffect(() => {
    let cancelled = false;
    const load = (): void => {
      void db.principal().then(
        (who) => {
          if (cancelled) return;
          setState({ eid: who.eid, class: who.class, loading: false });
        },
        (error: DbError) => {
          if (cancelled) return;
          onErrorRef.current?.(error);
          setState((prev) => ({ ...prev, loading: false }));
        },
      );
    };

    setState((prev) =>
      prev.loading ? prev : { eid: undefined, class: undefined, loading: true },
    );
    load();

    let generation = seamOf(db)?.generation();
    const off = seamOf(db)?.onWake(() => {
      const next = seamOf(db)?.generation();
      if (next === generation) return;
      generation = next;
      load();
    });

    return () => {
      cancelled = true;
      off?.();
    };
    // load closes over db; view is the structural identity
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  return state;
};
