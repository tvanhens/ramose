/**
 * `errorMessage` — the one-liner every toast wants.
 *
 * All of Ramose's `DbError`s carry a human-readable `message` and a `_tag`
 * discriminator, so `e.message ?? e._tag ?? String(e)` covers the typed
 * failures, bare tagged errors, and anything else that leaks out of an
 * Effect. This is its one home; apps should not restate it.
 */

/** `e.message ?? e._tag ?? String(e)`, tolerating non-string fields. */
export const errorMessage = (error: unknown): string => {
  if (typeof error === "object" && error !== null) {
    const { message, _tag } = error as { message?: unknown; _tag?: unknown };
    if (typeof message === "string" && message.length > 0) return message;
    if (typeof _tag === "string" && _tag.length > 0) return _tag;
  }
  return String(error);
};
