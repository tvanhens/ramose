export const normalizeDoc = (doc: string | undefined): string | undefined =>
  doc === undefined || doc.trim().length === 0 ? undefined : doc;

export const DOCUMENTATION: unique symbol = Symbol.for("ramose.documentation");

export const documentationOf = (value: unknown): string | undefined =>
  (value as { readonly [DOCUMENTATION]?: string })?.[DOCUMENTATION];
