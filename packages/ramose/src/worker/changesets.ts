import { decodeChangesetRequest } from "../internal/changesets/protocol.ts";
import { parseQueryDocument } from "../mcp/contract.ts";
import { queryMaxCells } from "./authorized-read.ts";
import { toJson } from "../internal/core/json.ts";
import * as Effect from "effect/Effect";
import { type AuthenticatedCaller, type AuthoritativeOperationInvocation, type CatalogId, type CatalogUnitHash, DatabaseId } from "../internal/authorization/index.ts";
import { internalHeaders } from "../internal/transactor/internal.ts";
import { openEntityId, sealEntityId } from "../internal/replication/entity-id.ts";
import type { ChangesetFact } from "../internal/authorization/changesets.ts";
import type { RamoseEnv } from "../RamoseEnv.ts";
import { deriveEntityIdScope, decodeOperationRequest } from "./authorized-operation.ts";
import { BadRequest, ChangesetRejected, Unauthorized, UpstreamError } from "./errors.ts";
import { invalidateBasis } from "./peer.ts";

export type ChangesetApproval = (caller: AuthenticatedCaller) => boolean;

export type ChangesetOptions = {
  readonly canApprove: ChangesetApproval;
  readonly requiresApproval?: ChangesetApproval;
};

export const requestChangeset = async (
  env: RamoseEnv,
  origin: string,
  database: string,
  catalogKey: CatalogId,
  unitHash: CatalogUnitHash,
  caller: AuthenticatedCaller,
  raw: unknown,
  canApprove?: ChangesetApproval,
): Promise<unknown> => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new BadRequest({ message: "invalid changeset request" });
  if (new TextEncoder().encode(JSON.stringify(raw)).byteLength > 65_536) throw new BadRequest({ message: "changeset request is too large" });
  let body;
  try { body = decodeChangesetRequest(raw); } catch { throw new BadRequest({ message: "invalid changeset request" }); }
  const action = body.action;
  if (action === "commit" && canApprove?.(caller) !== true) throw new Unauthorized({ status: 403 });
  if (action === "query") {
    try { parseQueryDocument(body.query); } catch { throw new BadRequest({ message: "invalid changeset query" }); }
  }
  const bound = await deriveEntityIdScope(env, database, origin, caller);
  const operations: AuthoritativeOperationInvocation[] = [];
  if (action === "prepare" || action === "append") {
    for (const operation of body.operations) {
      const parsed = await Effect.runPromise(decodeOperationRequest({
        ...operation, invocationId: `${body.id}:${operations.length}`,
      }));
      operations.push({ ...parsed, database: DatabaseId.make(database), catalogKey, unitHash, caller,
        entityIdScope: bound.scope, entityIdKeyId: bound.sealing.keyId });
    }
  }
  const decodeReferences = async (value: unknown): Promise<unknown> => {
    if (Array.isArray(value)) return Promise.all(value.map(decodeReferences));
    if (value === null || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length === 1 && typeof record.$entity === "string") {
      const resolved = await openEntityId(bound.sealing, bound.scope, record.$entity);
      if (resolved.type !== "resolved") throw new Unauthorized({ status: 403 });
      return resolved.eid;
    }
    return Object.fromEntries(await Promise.all(Object.entries(record).map(async ([key, item]) => [key, await decodeReferences(item)])));
  };
  const query = body.action === "read" ? await decodeReferences(body.query) : "query" in body ? body.query : undefined;
  const response = await env.TRANSACTOR.get(env.TRANSACTOR.idFromName(database)).fetch(
    `https://transactor/changesets?db=${encodeURIComponent(database)}`, {
      method: "POST", headers: { "content-type": "application/json", ...internalHeaders(env) },
      body: JSON.stringify({ ...body,
        database, catalogKey, unitHash, query, maxCells: queryMaxCells(env), caller,
        ...(operations.length === 0 ? {} : { operations: operations.map((invocation) => ({ ...invocation,
          ...(invocation.target === undefined ? {} : { target: toJson(invocation.target) }),
        })) }), approval: action === "commit" }),
    },
  );
  if (!response.ok) {
    const failure = await response.json() as { code?: string };
    if (response.status === 401 || response.status === 403) throw new Unauthorized({ status: 403 });
    if (response.status === 409 && typeof failure.code === "string" && [
      "changeset_revision_conflict", "changeset_closed", "changeset_stale", "changeset_expired",
      "changeset_limit", "changeset_too_large", "operation_changed", "invocation_update_required",
    ].includes(failure.code)) throw new ChangesetRejected({ code: failure.code });
    throw new UpstreamError({ status: response.status, body: JSON.stringify({
      error: "changeset request failed", code: failure.code ?? "changeset_failed",
    }) });
  }
  const result = await response.json() as { rows?: readonly { entity: number; data: Record<string, unknown> }[]; changes?: readonly ChangesetFact[]; status?: string; entities?: readonly number[] };
  if (result.status === "committed") invalidateBasis(database);
  if (caller.exp * 1000 <= Date.now()) throw new Unauthorized({ status: 403 });
  if (result.entities !== undefined) return { ...result, entities: await Promise.all(result.entities.map((eid) => sealEntityId(bound.sealing, bound.scope, eid))) };
  if (result.rows !== undefined) return { ...result, rows: await Promise.all(result.rows.map(async (row) => ({
    ...row, entity: await sealEntityId(bound.sealing, bound.scope, row.entity),
  }))) };
  if (result.changes === undefined) return result;
  const changes = await Promise.all(result.changes.map(async (fact) => ({
    entity: await sealEntityId(bound.sealing, bound.scope, fact.entity),
    field: fact.field,
    value: fact.reference
      ? await sealEntityId(bound.sealing, bound.scope, fact.value as number)
      : fact.value,
    added: fact.added,
  })));
  return { ...result, changes };
};
