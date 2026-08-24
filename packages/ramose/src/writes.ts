/**
 * Who may POST raw `/transact`. Shared by `Server` (deploy) and the Worker
 * (request) so the `"operations"` default cannot drift.
 *
 * `"operations"` is the peer default — unset `RAMOSE_WRITES` means this.
 * `"all"` is the explicit opt-out. Unrecognized env values fail closed to
 * `"operations"`; the Worker logs `writes.unrecognized`.
 */

export type WritesMode = "all" | "operations";

/** Env key `Server({ writes })` lowers onto. */
export const WRITES_ENV_KEY = "RAMOSE_WRITES" as const;

/** Worker→replica session upgrade: the resolved write mode. */
export const WRITES_HEADER = "x-ramose-writes";

export const isWritesMode = (value: unknown): value is WritesMode =>
  value === "all" || value === "operations";

/**
 * Server prop wins when set; otherwise the Worker env; otherwise `"operations"`.
 * Only the exact string `"all"` opts out — `All` / `ALL` / typos fail closed.
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
