/**
 * Depth-budget stress for the depth-capped encoding.
 * How many `friends` hops still resolve `.name`?
 */

import type { Equal, Expect } from "../../../src/db/equal.ts";
import { User } from "./fixture.ts";
import type { IdentOf } from "./types.ts";

type H1 = IdentOf<typeof User.friends.name>;
type H2 = IdentOf<typeof User.friends.friends.name>;
type H3 = IdentOf<typeof User.friends.friends.friends.name>;
type H4 = IdentOf<typeof User.friends.friends.friends.friends.name>;
type H5 = IdentOf<typeof User.friends.friends.friends.friends.friends.name>;
type H6 =
  IdentOf<typeof User.friends.friends.friends.friends.friends.friends.name>;

type _1 = Expect<Equal<H1, ":user/name">>;
type _2 = Expect<Equal<H2, ":user/name">>;
type _3 = Expect<Equal<H3, ":user/name">>;
type _4 = Expect<Equal<H4, ":user/name">>;
type _5 = Expect<Equal<H5, ":user/name">>;
type _6 = Expect<Equal<H6, ":user/name">>;

// 7th self-hop: depth default is 6, so navigation stops (SelfMarker).
declare const seven: typeof User.friends.friends.friends.friends.friends.friends.friends;
// @ts-expect-error depth budget exhausted — SelfMarker does not navigate
const _h7: typeof seven.name = null as never;