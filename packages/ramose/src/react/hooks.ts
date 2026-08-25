"use client";

/** `useDb` and `useRamoseClaims` — the provider-owned seams. */

import type { Schema, Claims, Client, Db } from "../db/index.ts";
import { peekClaims } from "../db/token.ts";
import { useContext, useEffect, useMemo, useState } from "react";
import { RamoseContext, type RamoseContextValue } from "./context.ts";

const missingProvider = (hook: string): Error =>
  new Error(
    `${hook}: no <RamoseProvider> above this component. ` +
      "Wrap your tree in <RamoseProvider url={…}> from \"ramose/react\" " +
      "and call the hook inside it.",
  );

/**
 * The context the nearest `<RamoseProvider>` owns.
 *
 * Throws outside a provider: a missing provider is a wiring mistake, not a
 * state to render around.
 */
const useRamoseContext = (): RamoseContextValue => {
  const ctx = useContext(RamoseContext);
  if (ctx === null) throw missingProvider("useDb");
  return ctx;
};

/**
 * The `Client` the nearest `<RamoseProvider>` owns.
 *
 * Throws outside a provider: a missing provider is a wiring mistake, not a
 * state to render around.
 */
const useClient = (): Client => useRamoseContext().client;

/**
 * `client.db(name, schema)`, memoised on `[client, name, schema]`.
 *
 * The call itself is pure — no network, no ensure, no socket — so the memo is
 * purely about identity: a stable `Db` reference means effects and memos
 * keyed on it do not re-fire every render. Pass a module-scope schema (the
 * normal spelling) or the identity changes every render and the memo is
 * worthless.
 */
export const useDb = <C extends Schema.Any>(name: string, schema: C): Db<C> => {
  const client = useClient();
  return useMemo(() => client.db(name, schema), [client, name, schema]);
};

/**
 * The provider's token payload, decoded, **not** verified — UI hints only
 * (`ramose.class`, `sub`, `exp`). Synchronous when the source already has a
 * cached JWT (Reef warms `token.claims()` before the board mounts); a cold
 * source mints once and this hook re-renders with the payload.
 *
 * Throws outside a provider. A string token decodes on the first render; a
 * mint function with no cache is `undefined` until something reads it.
 */
export const useRamoseClaims = (): Claims | undefined => {
  const ctx = useContext(RamoseContext);
  if (ctx === null) throw missingProvider("useRamoseClaims");
  const { token } = ctx;
  const [claims, setClaims] = useState(() => peekClaims(token));

  useEffect(() => {
    const peeked = peekClaims(token);
    if (peeked !== undefined) {
      setClaims(peeked);
      return;
    }
    if (
      typeof token !== "object" ||
      token === null ||
      typeof token.claims !== "function"
    ) {
      setClaims(peekClaims(token));
      return;
    }
    let cancelled = false;
    void token.claims().then(
      (next) => {
        if (!cancelled) setClaims(next);
      },
      () => {
        if (!cancelled) setClaims(undefined);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [token]);

  return claims ?? peekClaims(token);
};
