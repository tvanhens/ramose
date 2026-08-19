/** Compile-time equality for type fixtures (`Expect<Equal<A, B>>`). */

export type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

export type Expect<T extends true> = T;

/** `true` when `A` is assignable to `B`. */
export type Extends<A, B> = [A] extends [B] ? true : false;
