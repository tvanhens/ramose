import * as S from "effect/Schema";
import { CatalogId, CatalogUnitHash, DatabaseId, OperationVersion, OwnerRef } from "./identities.ts";
import { JsonValue } from "./json.ts";
import { parseInvocationAllocations } from "./entity-targets.ts";
import type { AuthoritativeOperationInvocation } from "./invocation-receipts.ts";
import { fromJson } from "../core/json.ts";
import type { EntityRef } from "../core/db.ts";

export const AuthenticatedCallerSchema = S.Struct({
  claims: S.Record(S.String, JsonValue), classes: S.Array(S.String), exp: S.Int,
});

const Invocation = S.Struct({
  database: DatabaseId, catalogKey: CatalogId, unitHash: CatalogUnitHash,
  owner: OwnerRef, localName: S.String, invocationId: S.String,
  operationVersion: S.optionalKey(OperationVersion), target: S.optionalKey(S.Unknown),
  sealedTarget: S.optionalKey(S.String), entityIdKeyId: S.optionalKey(S.String),
  entityIdScope: S.optionalKey(S.Struct({ server: S.String, principal: S.String, database: S.String })),
  allocations: S.optionalKey(S.Unknown), input: S.Unknown, caller: AuthenticatedCallerSchema,
});
const decode = S.decodeUnknownSync(Invocation);

export const decodeOperationInvocation = (input: unknown): AuthoritativeOperationInvocation => {
  const wire = decode(input);
  const value = fromJson(wire.target);
  let target: EntityRef | undefined;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) target = value;
  else if (typeof value === "string" && value.length > 0) target = value;
  else if (Array.isArray(value) && value.length === 2 && typeof value[0] === "string") target = [value[0], value[1]];
  else if (value !== undefined) throw new Error("invalid operation target");
  const allocations = parseInvocationAllocations(wire.allocations);
  if (allocations === undefined) throw new Error("invalid operation allocations");
  const { target: _target, allocations: _allocations, ...invocation } = wire;
  return { ...invocation, ...(target === undefined ? {} : { target }), ...(allocations.length === 0 ? {} : { allocations }) };
};
