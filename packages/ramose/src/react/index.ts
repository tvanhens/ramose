"use client";

/**
 * `ramose/react` — React bindings for Ramose. Named hooks, not a namespace:
 *
 * ```tsx
 * import { RamoseProvider, useDb } from "ramose/react";
 * ```
 *
 * `RamoseProvider` owns one `Client` per subtree (connect on mount / prop
 * change, close on unmount / prop change, StrictMode-safe), `useRamose()`
 * hands it back, and `useDb(name, catalog)` memoises a `Db` from it. On top
 * sit the reads — `useLive` (standing query as state), `useQuery` (one-shot
 * `db.q` as `Async`), `usePull` (standing `db.livePull` as `Live`),
 * `useBasis` (where the basis is) — plus `useTransact()` for writes from
 * event handlers (works with or without the provider) and `errorMessage`
 * for toast text.
 *
 * This entry and every hook module it re-exports open with `"use client"`
 * so a Next App Router / React Router server-component import compiles.
 * Keep the directive as the first statement — bundlers and `tsc` emit
 * look for that, and `test/react/use-client.test.ts` pins it.
 */

export { RamoseProvider, type RamoseProviderProps } from "./RamoseProvider.tsx";
export { useDb, useRamose } from "./hooks.ts";
export { type Live, useLive } from "./useLive.ts";
export { type Async, useQuery } from "./useQuery.ts";
export { usePull } from "./usePull.ts";
export { useBasis } from "./useBasis.ts";
export { type Transact, useTransact } from "./useTransact.ts";
export { errorMessage } from "./errors.ts";
