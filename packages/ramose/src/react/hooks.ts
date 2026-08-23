"use client";

/** `useDb` — the hook every other hook here builds on. */

import type { Schema, Client, Db } from "../db/index.ts";
import { useContext, useMemo } from "react";
import { RamoseContext } from "./context.ts";

/**
 * The `Client` the nearest `<RamoseProvider>` owns.
 *
 * Throws outside a provider: a missing provider is a wiring mistake, not a
 * state to render around.
 */
const useClient = (): Client => {
  const client = useContext(RamoseContext);
  if (client === null) {
    throw new Error(
      "useDb: no <RamoseProvider> above this component. " +
        "Wrap your tree in <RamoseProvider url={…}> from \"ramose/react\" " +
        "and call the hook inside it.",
    );
  }
  return client;
};

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
