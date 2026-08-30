export const isAttrRef = (a: unknown): a is { readonly ident: string } =>
  typeof a === "object" &&
  a !== null &&
  "ident" in a &&
  typeof (a as { ident: unknown }).ident === "string";

export const lowerAttr = (a: unknown): string =>
  isAttrRef(a) ? a.ident : (a as string);
