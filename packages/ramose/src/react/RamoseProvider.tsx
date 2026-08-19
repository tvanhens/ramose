/**
 * `RamoseProvider` — one `Client`, owned by the tree: `Ramose.connect` in a
 * `useMemo` keyed on `url` and the identity of `token` / `fetch` /
 * `webSocket`, close in the effect cleanup on change and on unmount.
 *
 * Two rules the memo imposes on consumers:
 *
 * - `token` must be a **stable** `TokenSource` (`Ramose.token.jwt(...)` built
 *   once — module scope or a `useMemo`), not an Effect built inline in the
 *   render, or the client re-connects every render.
 * - Multi-tenant remount is React's own `key`: `<RamoseProvider key={slug}
 *   url={…}>` closes the old tenant's client and connects the new one.
 */

import {
  type Client,
  type ClientOptions,
  connect,
} from "../db/index.ts";
import {
  type ReactNode,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from "react";
import { RamoseContext } from "./context.ts";

/**
 * `ClientOptions` plus `children`. React's own `key` is the multi-tenant
 * remount seam: change it to close the old client and connect a new one.
 */
export interface RamoseProviderProps extends ClientOptions {
  readonly children?: ReactNode;
}

export const RamoseProvider = (props: RamoseProviderProps) => {
  const { url, token, fetch, webSocket, children } = props;
  const [generation, reconnect] = useReducer((n: number) => n + 1, 0);
  /** The client the last cleanup closed — identity, not a flag on the memo. */
  const closed = useRef<Client | null>(null);

  // a client StrictMode's double render discards is harmless: `connect`
  // opens no sockets until a first read, so there is nothing to close
  const client = useMemo(
    () => connect({ url, token, fetch, webSocket }),
    [url, token, fetch, webSocket, generation],
  );

  useEffect(() => {
    if (closed.current === client) {
      // StrictMode's mount → close → mount: the memo survived but the first
      // cleanup closed its client. Re-key the memo; the re-render connects a
      // fresh client and the next effect pass owns it.
      reconnect();
      return;
    }
    return () => {
      closed.current = client;
      void client.close();
    };
  }, [client]);

  return (
    <RamoseContext.Provider value={client}>{children}</RamoseContext.Provider>
  );
};
