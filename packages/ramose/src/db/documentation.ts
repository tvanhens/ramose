/** Optional Markdown documentation carried by code-deployed schema metadata. */
export const normalizeDoc = (doc: string | undefined): string | undefined =>
  doc === undefined || doc.trim().length === 0 ? undefined : doc;
