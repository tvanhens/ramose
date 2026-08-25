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
 * `useTransact()` as the pending / error helper around `db.run` (works
 * with or without the provider) and `errorMessage` for toast text.
 *
 * This entry and every hook module it re-exports open with `"use client"`
 * so a Next App Router / React Router server-component import compiles.
 * Keep the directive as the first statement — bundlers and `tsc` emit
 * look for that, and `test/react/use-client.test.ts` pins it.
 */

export { RamoseProvider, type RamoseProviderProps } from "./RamoseProvider.tsx";
export { useDb } from "./hooks.ts";
export { type Read, type ReadStatus } from "./read.ts";
export { useLiveQuery } from "./useLiveQuery.ts";
export { useQuery } from "./useQuery.ts";
export { useLivePull, usePull } from "./usePull.ts";
export { useBasis } from "./useBasis.ts";
export { type RunResult, type Transact, useTransact } from "./useTransact.ts";
export { errorMessage } from "./errors.ts";
