/**
 * Session/Worker write-mode plumbing. Raw external writes are not admitted.
 * Unrecognized env values fail closed to `"operations"`; the Worker logs
 * `writes.unrecognized`.
 */

export type WritesMode = "all" | "operations";

/** Leftover Worker env key. Not a public opt-out for raw writes. */
export const WRITES_ENV_KEY = "RAMOSE_WRITES" as const;

/** Worker→replica session upgrade: the resolved write mode. */
export const WRITES_HEADER = "x-ramose-writes";

export const isWritesMode = (value: unknown): value is WritesMode =>
  value === "all" || value === "operations";

/**
 * Explicit mode wins when set; otherwise the Worker env; otherwise `"operations"`.
 * Typos fail closed.
 */
export const resolveWrites = (
  writes: WritesMode | undefined,
  envWrites: unknown,
): WritesMode => {
  if (isWritesMode(writes)) return writes;
  return envWrites === "all" ? "all" : "operations";
};

export const parseWritesHeader = (raw: string | null | undefined): WritesMode | undefined =>
  isWritesMode(raw) ? raw : undefined;

/** Set and neither `"all"` nor `"operations"` — warn, then fail closed. */
export const isUnrecognizedWrites = (envWrites: unknown): boolean =>
  envWrites !== undefined && envWrites !== "" && !isWritesMode(envWrites);
