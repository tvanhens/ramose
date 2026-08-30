export type WritesMode = "all" | "operations";

export const WRITES_ENV_KEY = "RAMOSE_WRITES" as const;

export const WRITES_HEADER = "x-ramose-writes";

export const isWritesMode = (value: unknown): value is WritesMode =>
  value === "all" || value === "operations";

export const resolveWrites = (
  writes: WritesMode | undefined,
  envWrites: unknown,
): WritesMode => {
  if (isWritesMode(writes)) return writes;
  return envWrites === "all" ? "all" : "operations";
};

export const parseWritesHeader = (raw: string | null | undefined): WritesMode | undefined =>
  isWritesMode(raw) ? raw : undefined;

export const isUnrecognizedWrites = (envWrites: unknown): boolean =>
  envWrites !== undefined && envWrites !== "" && !isWritesMode(envWrites);
