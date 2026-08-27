/**
 * Server-side operation execution.
 *
 * Catalog-local lookup and operation authorization land in #341 / #345.
 * Until then, every operation fails closed (AUTH-1, FC-1).
 */

import type { AnyOperation, AnyOperations } from "../db/Operation.ts";
import type { Principal } from "./auth.ts";
import { Unauthorized } from "./errors.ts";
import type { WritesMode } from "../writes.ts";
import type { RamoseEnv } from "../RamoseEnv.ts";

export interface ServerOptions {
  readonly operations?: AnyOperations;
  readonly writes?: WritesMode;
}

export const lookupOperation = (
  registry: AnyOperations | undefined,
  name: string,
): AnyOperation | undefined => registry?.get(name);

export interface ExecuteArgs {
  readonly env: RamoseEnv;
  readonly request: Request;
  readonly db: string;
  readonly principal: Principal;
  readonly registry: AnyOperations | undefined;
  readonly name: string;
  readonly entity: unknown;
  readonly input: unknown;
  readonly clientOpId?: string | undefined;
}

export interface ExecuteReady {
  readonly tx: unknown[];
  readonly output: unknown;
  readonly principal: Principal;
  readonly clientOpId?: string | undefined;
  encodeOutput(tempids: Readonly<Record<string, number>>): Promise<unknown>;
}

export async function prepareOperation(_args: ExecuteArgs): Promise<ExecuteReady> {
  throw new Unauthorized({});
}
