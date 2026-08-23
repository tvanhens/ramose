/**
 * @internal The one context this package carries: the `Client` the nearest
 * `RamoseProvider` owns. Deliberately not exported from the package — the
 * public way in is `useDb()`, and the public way to put one in the tree
 * is `<RamoseProvider>`.
 */

import type { Client } from "../db/index.ts";
import { createContext } from "react";

export const RamoseContext = createContext<Client | null>(null);
