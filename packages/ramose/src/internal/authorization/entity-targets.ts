import {
  isAllocationSlotName,
  readAllocationPath,
  type AllocationPathSegment,
} from "../../db/allocations.ts";
import { isClientRef, type ClientRef } from "../../db/refs.ts";
import {
  openEntityId,
  sealEntityId,
  SEALED_ENTITY_ID_MIN_LENGTH,
  type EntityIdScope,
  type SealedEntityId,
} from "../replication/entity-id.ts";
import type { ServerSealingKey } from "../replication/server-identity.ts";
import type {
  AllocationSlotDescriptor,
  OperationInputShape,
  OperationWireShape,
} from "./catalog.ts";

export type InvocationAllocation = {
  readonly slot: string;
  readonly clientRef: ClientRef;
};

export const parseInvocationAllocations = (
  value: unknown,
): readonly InvocationAllocation[] | undefined => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  const slots = new Set<string>();
  const refs = new Set<string>();
  const parsed: InvocationAllocation[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return undefined;
    }
    const record = entry as Record<string, unknown>;
    if (
      Object.keys(record).length !== 2 ||
      !isAllocationSlotName(record.slot) || !isClientRef(record.clientRef)
    ) return undefined;
    if (slots.has(record.slot) || refs.has(record.clientRef)) return undefined;
    slots.add(record.slot);
    refs.add(record.clientRef);
    parsed.push(Object.freeze({ slot: record.slot, clientRef: record.clientRef }));
  }
  return Object.freeze(
    parsed.sort((left, right) =>
      left.slot < right.slot ? -1 : left.slot > right.slot ? 1 : 0
    ),
  );
};

export type EpochBoundScope = {
  readonly keyId: string;
  readonly scope: EntityIdScope;
};

export type EpochDecision =
  | {
    readonly _tag: "Agreed";
    readonly sealing: ServerSealingKey;
    readonly scope: EntityIdScope;
  }
  | { readonly _tag: "UpdateRequired" };

const EPOCH_UPDATE_REQUIRED = Object.freeze(
  { _tag: "UpdateRequired" },
) as EpochDecision;

export const decideEpoch = (
  bound: EpochBoundScope,
  sealing: ServerSealingKey,
): EpochDecision =>
  bound.keyId === sealing.keyId
    ? Object.freeze({ _tag: "Agreed", sealing, scope: bound.scope })
    : EPOCH_UPDATE_REQUIRED;

export const sameEpochScope = (
  left: EpochBoundScope,
  right: EpochBoundScope,
): boolean =>
  left.keyId === right.keyId &&
  left.scope.server === right.scope.server &&
  left.scope.principal === right.scope.principal &&
  left.scope.database === right.scope.database;

export const parseEntityIdScope = (
  value: unknown,
): EntityIdScope | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.server !== "string" || record.server.length === 0 ||
    typeof record.principal !== "string" || record.principal.length === 0 ||
    typeof record.database !== "string" || record.database.length === 0
  ) return undefined;
  return Object.freeze({
    server: record.server,
    principal: record.principal,
    database: record.database,
  });
};

const MAX_SEALED_TARGET_LENGTH = 4096;

export type SealedTargetResolution =
  | { readonly _tag: "Resolved"; readonly eid: number }
  | { readonly _tag: "UpdateRequired" }
  | { readonly _tag: "Denied" };

const DENIED = Object.freeze({ _tag: "Denied" }) as SealedTargetResolution;
const UPDATE_REQUIRED = Object.freeze(
  { _tag: "UpdateRequired" },
) as SealedTargetResolution;

export const resolveSealedTarget = async (
  sealing: ServerSealingKey,
  scope: EntityIdScope,
  token: string,
): Promise<SealedTargetResolution> => {
  if (token.length === 0 || token.length > MAX_SEALED_TARGET_LENGTH) return DENIED;
  const resolution = await openEntityId(sealing, scope, token);
  switch (resolution.type) {
    case "resolved":
      return Object.freeze({ _tag: "Resolved", eid: resolution.eid });
    case "update-required":
      return UPDATE_REQUIRED;
    case "denied":
      return DENIED;
  }
};

export const isEntityRefPath = (
  shape: OperationInputShape,
  path: readonly AllocationPathSegment[],
): boolean => {
  let cursor: OperationInputShape = shape;
  for (const segment of path) {
    if (cursor._tag === "array") {
      if (typeof segment !== "number") return false;
      cursor = cursor.items;
      continue;
    }
    if (cursor._tag === "struct") {
      if (typeof segment !== "string") return false;
      const field = cursor.fields.find((candidate) => candidate.key === segment);
      if (field === undefined) return false;
      cursor = field.shape;
      continue;
    }
    return false;
  }
  return cursor._tag === "ref";
};

export type AllocatedSlot = {
  readonly slot: string;
  readonly eid: number;
};

export type AllocationExtraction =
  | { readonly _tag: "Allocated"; readonly slots: readonly AllocatedSlot[] }
  | { readonly _tag: "Unallocated"; readonly slot: string };

export const allocatedEids = (
  tempids: Readonly<Record<string, number>>,
): ReadonlySet<number> => new Set(Object.values(tempids));

export const extractAllocations = (
  declared: readonly AllocationSlotDescriptor[],
  outputShape: OperationInputShape,
  output: unknown,
  requested: readonly InvocationAllocation[],
  allocated: ReadonlySet<number>,
): AllocationExtraction => {
  const slots: AllocatedSlot[] = [];
  for (const allocation of requested) {
    const declaration = declared.find(
      (candidate) => candidate.slot === allocation.slot,
    );
    if (
      declaration === undefined ||
      !isEntityRefPath(outputShape, declaration.path)
    ) {
      return Object.freeze({ _tag: "Unallocated", slot: allocation.slot });
    }
    const value = readAllocationPath(output, declaration.path);
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      return Object.freeze({ _tag: "Unallocated", slot: allocation.slot });
    }
    if (!allocated.has(value)) {
      return Object.freeze({ _tag: "Unallocated", slot: allocation.slot });
    }
    slots.push(Object.freeze({ slot: allocation.slot, eid: value }));
  }
  return Object.freeze({ _tag: "Allocated", slots: Object.freeze(slots) });
};

export const wireEntityRefPaths = (
  shape: OperationWireShape,
  value: unknown,
  holds: (candidate: unknown) => boolean,
): readonly (readonly AllocationPathSegment[])[] => {
  const paths: (readonly AllocationPathSegment[])[] = [];
  const walk = (
    current: OperationWireShape,
    node: unknown,
    path: readonly AllocationPathSegment[],
  ): void => {
    switch (current._tag) {
      case "ref":
        if (holds(node)) paths.push(Object.freeze([...path]));
        return;
      case "array":
        if (Array.isArray(node)) {
          for (let index = 0; index < node.length; index++) {
            walk(current.items, node[index], [...path, index]);
          }
        }
        return;
      case "struct":
        if (typeof node === "object" && node !== null && !Array.isArray(node)) {
          for (const field of current.fields) {
            if (!Object.hasOwn(node, field.key)) continue;
            walk(
              field.shape,
              (node as Record<string, unknown>)[field.key],
              [...path, field.key],
            );
          }
        }
        return;
      case "scalar":
      case "opaque":
        return;
    }
  };
  walk(shape, value, []);
  return Object.freeze(paths);
};

const isResolvedEid = (candidate: unknown): boolean =>
  typeof candidate === "number" && Number.isSafeInteger(candidate) &&
  candidate >= 0;

export const outputEntityRefPaths = (
  shape: OperationWireShape,
  output: unknown,
): readonly (readonly AllocationPathSegment[])[] =>
  wireEntityRefPaths(shape, output, isResolvedEid);

const replaceAt = (
  value: unknown,
  path: readonly AllocationPathSegment[],
  replacement: unknown,
): unknown => {
  const [head, ...rest] = path;
  if (head === undefined) return replacement;
  if (typeof head === "number") {
    if (!Array.isArray(value) || head >= value.length) {
      throw new Error("entity-reference position is not an array index");
    }
    const copy = [...value];
    copy[head] = replaceAt(value[head], rest, replacement);
    return copy;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("entity-reference position is not an object property");
  }
  const record = value as Record<string, unknown>;
  if (!Object.hasOwn(record, head)) {
    throw new Error("entity-reference position is absent");
  }
  return { ...record, [head]: replaceAt(record[head], rest, replacement) };
};

export const sealOutputEntityRefs = async (
  sealing: ServerSealingKey,
  scope: EntityIdScope,
  output: unknown,
  paths: readonly (readonly AllocationPathSegment[])[],
): Promise<unknown> => {
  const sealed = await Promise.all(
    paths.map(async (path) => {
      const eid = readAllocationPath(output, path);
      if (typeof eid !== "number" || !Number.isSafeInteger(eid) || eid < 0) {
        throw new Error("output entity-reference position holds no resolved eid");
      }
      return { path, handle: await sealEntityId(sealing, scope, eid) };
    }),
  );
  let projected = output;
  for (const { path, handle } of sealed) {
    projected = replaceAt(projected, path, handle);
  }
  return projected;
};

const BASE64URL = /^[A-Za-z0-9_-]+$/;

const mayBeSealedEntityId = (value: string): boolean =>
  value.length >= SEALED_ENTITY_ID_MIN_LENGTH &&
  value.length <= MAX_SEALED_TARGET_LENGTH &&
  value.length % 4 !== 1 &&
  BASE64URL.test(value);

export const mayCarrySealedEntityId = (input: unknown): boolean => {
  const seen = new Set<object>();
  const pending: unknown[] = [input];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string") {
      if (mayBeSealedEntityId(value)) return true;
      continue;
    }
    if (typeof value !== "object" || value === null) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      pending.push(child);
    }
  }
  return false;
};

export const inputEntityRefHandles = (
  shape: OperationWireShape,
  input: unknown,
): readonly (readonly AllocationPathSegment[])[] =>
  wireEntityRefPaths(shape, input, (candidate) => typeof candidate === "string");

export type SealedInputResolution =
  | { readonly _tag: "Resolved"; readonly input: unknown }
  | { readonly _tag: "UpdateRequired" }
  | { readonly _tag: "Denied" };

const DENIED_INPUT = Object.freeze({ _tag: "Denied" }) as SealedInputResolution;
const UPDATE_REQUIRED_INPUT = Object.freeze(
  { _tag: "UpdateRequired" },
) as SealedInputResolution;

export const resolveSealedInputRefs = async (
  sealing: ServerSealingKey,
  scope: EntityIdScope,
  input: unknown,
  paths: readonly (readonly AllocationPathSegment[])[],
): Promise<SealedInputResolution> => {
  const opened = await Promise.all(paths.map(async (path) => {
    const token = readAllocationPath(input, path);
    if (typeof token !== "string") {
      throw new Error("input entity-reference position holds no handle");
    }
    return { path, resolution: await resolveSealedTarget(sealing, scope, token) };
  }));
  if (opened.some(({ resolution }) => resolution._tag === "UpdateRequired")) {
    return UPDATE_REQUIRED_INPUT;
  }
  if (opened.some(({ resolution }) => resolution._tag === "Denied")) {
    return DENIED_INPUT;
  }
  let resolved = input;
  for (const { path, resolution } of opened) {
    if (resolution._tag !== "Resolved") continue;
    resolved = replaceAt(resolved, path, resolution.eid);
  }
  return Object.freeze({ _tag: "Resolved" as const, input: resolved });
};

export type SealedAllocationMapping = {
  readonly slot: string;
  readonly clientRef: string;
  readonly entityId: SealedEntityId;
};

export const sealAllocationMappings = async (
  sealing: ServerSealingKey,
  scope: EntityIdScope,
  slots: readonly AllocatedSlot[],
  requested: readonly InvocationAllocation[],
): Promise<readonly SealedAllocationMapping[]> => {
  const bound = new Map(requested.map((entry) => [entry.slot, entry.clientRef]));
  return Object.freeze(
    await Promise.all(slots.map(async (allocated) => {
      const clientRef = bound.get(allocated.slot);
      if (clientRef === undefined) {
        throw new Error("allocated slot has no bound client ref");
      }
      return Object.freeze({
        slot: allocated.slot,
        clientRef,
        entityId: await sealEntityId(sealing, scope, allocated.eid),
      });
    })),
  );
};
