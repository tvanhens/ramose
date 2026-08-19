/** @internal Shared attr-ref narrowing / ident lowering. Not part of the public surface. */

export const isAttrRef = (a: unknown): a is { readonly ident: string } =>
  typeof a === "object" &&
  a !== null &&
  "ident" in a &&
  typeof (a as { ident: unknown }).ident === "string";

/** `User.name` → `":user/name"`; an ident string passes through. */
export const lowerAttr = (a: unknown): string =>
  isAttrRef(a) ? a.ident : (a as string);
