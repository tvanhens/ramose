/** Optional Markdown documentation carried by code-deployed schema metadata. */
export const normalizeDoc = (doc: string | undefined): string | undefined =>
  doc === undefined || doc.trim().length === 0 ? undefined : doc;

/** Internal documentation slot that cannot collide with an application field. */
export const DOCUMENTATION: unique symbol = Symbol.for("ramose.documentation");

/** Read code-deployed documentation independently of flattened field names. */
export const documentationOf = (value: unknown): string | undefined =>
  (value as { readonly [DOCUMENTATION]?: string })?.[DOCUMENTATION];
