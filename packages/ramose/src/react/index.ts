"use client";

/**
 * `ramose/react` — React bindings for Ramose. Named hooks, not a namespace:
 *
 * ```tsx
 * import { RamoseProvider, useDb } from "ramose/react";
 * ```
 *
 * `RamoseProvider` owns one `Client` per subtree (connect on mount / prop
 * change, close on unmount / prop change, StrictMode-safe), and
 * `useDb(name, schema)` memoises a `Db` from it. On top sit the reads —
 * `useLiveQuery` / `useQuery`, `useLivePull` / `usePull`, `useBasis`
 * (where the basis is) — all returning the same `Read` shape — plus
 * `useConnectionStatus()` (session-backed), `usePrincipal(db)` /
 * `useRamoseClaims()` for who the session is, `useOperation(db, op)` as
 * the pending / error helper around `db.run`, and `errorMessage` for
 * toast text.
 *
 * This entry and every hook module it re-exports open with `"use client"`
 * so a Next App Router / React Router server-component import compiles.
 * Keep the directive as the first statement — bundlers and `tsc` emit
 * look for that, and `test/react/use-client.test.ts` pins it.
 */

export { RamoseProvider, type RamoseProviderProps } from "./RamoseProvider.tsx";
export { useDb, useRamoseClaims } from "./hooks.ts";
export { type ConnectionStatus } from "../db/index.ts";
export { useConnectionStatus } from "./useConnectionStatus.ts";
export { type Read, type ReadStatus } from "./read.ts";
export { useLiveQuery } from "./useLiveQuery.ts";
export { useQuery } from "./useQuery.ts";
export { useLivePull, usePull } from "./usePull.ts";
export { useBasis } from "./useBasis.ts";
export { type Principal, usePrincipal } from "./usePrincipal.ts";
export {
  type OperationHandle,
  type OperationOptions,
  type RunResult,
  useOperation,
} from "./useOperation.ts";
export { errorMessage } from "./errors.ts";
