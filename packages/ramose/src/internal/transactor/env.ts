export type { RamoseEnv } from "../../RamoseEnv.ts";

export function envInt(v: string | undefined, dflt: number): number {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : dflt;
}
