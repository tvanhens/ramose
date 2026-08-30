/**
 * Opaque entity handles at the authoritative operation edge (#475 slice 2).
 *
 * Two directions, one scope:
 *
 *  - **inbound** — an invocation may name an entity as a sealed `EntityId`
 *    rather than a numeric eid or a lookup ref, both as its target and at any
 *    position the deployed input shape declares a `ref`
 *    ({@link resolveSealedTarget}, {@link resolveSealedInputRefs}). Each is
 *    decrypted under the scope the Worker derived from the *authenticated*
 *    request and replaced by the private eid. That is an identity claim and
 *    nothing more: the caller then runs its ordinary visibility, type, and
 *    admission checks on the resolved eids, exactly as it would for numeric
 *    ones. Resolution grants nothing.
 *  - **outbound** — an operation that declares named allocation slots gets
 *    `{ slot → eid }` read out of its own authoritative output at the declared
 *    entity-reference paths, and those eids are sealed back into handles for
 *    the durable receipt. A numeric eid never reaches the receipt.
 *
 * ## Failure taxonomy, frozen
 *
 * An unreadable codec version or a replaced key epoch is the typed, *data-free*
 * `update-required` quarantine, decided from the envelope preamble before any
 * key is derived. Everything else — malformed, tampered, wrong scope, wrong key
 * material — collapses into the single sealed denial (#419), indistinguishable
 * from not-found and from unauthorized.
 *
 * ## Why the slot's value is never guessed
 *
 * A declared path is read against the *deployed descriptor's* output shape, and
 * the position it lands on must be a `ref`. An operation output number is not
 * self-describing, and a transaction tempid is transaction-local, so inferring
 * a mapping from either would bind a durable client identity to a coincidence.
 * A slot whose declared path is absent, is not a ref position, or does not hold
 * a resolved eid fails the invocation rather than producing a partial mapping.
 */

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
import type { AllocationSlotDescriptor, OperationInputShape } from "./catalog.ts";

/**
 * One `{ slot, clientRef }` binding a caller supplied with its invocation.
 * The slot names a declaration on the deployed operation; the client ref is
 * the durable identity the client already minted for that entity.
 */
export type InvocationAllocation = {
  readonly slot: string;
  readonly clientRef: ClientRef;
};

/**
 * Validate and canonically order the caller's allocation bindings.
 *
 * Ordering is by slot name, matching how `allocationSlots` orders a
 * declaration, so the canonical invocation digest cannot depend on the order a
 * caller happened to serialize its bindings in. Returns `undefined` for
 * anything malformed; the caller turns that into its ordinary refusal.
 */
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
    // A slot maps to exactly one entity and a client ref names exactly one
    // entity, so either duplicate would make the durable mapping ambiguous.
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

/* ── sealing-root epoch coherence ─────────────────────────────────────────
 *
 * Every scope component is a PRF of the durable identity root, and every
 * sealed handle is ciphertext under a key derived from it with the scope as
 * additional data. A scope and a handle from *different* epochs therefore name
 * nothing: the handle authenticates against additional data the other key
 * cannot reproduce.
 *
 * The participants do not share an isolate. The Worker derives the scope from
 * its cached root; the writer seals and opens from its own; the durable receipt
 * holds mappings minted under whatever epoch was current when it committed. A
 * root replacement — or two isolates warming at different moments across one —
 * can leave any pair of them disagreeing.
 *
 * One rule covers all of them: **carry the epoch you derived under, compare
 * before acting, and answer the typed data-free quarantine on disagreement.**
 * Never a sealed denial: the caller is authorized and its handles are genuine,
 * they have simply moved out of reach, and only `update-required` tells a
 * durable client to mint fresh identities instead of retrying forever.
 *
 * {@link EpochBoundScope} is what makes the rule hard to forget — a scope
 * cannot be passed anywhere without the epoch that produced it.
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * A scope and the sealing key epoch it was derived under. One value, because a
 * scope apart from its epoch is not merely useless but actively unsafe: it
 * looks usable and produces handles nothing can open.
 */
export type EpochBoundScope = {
  readonly keyId: string;
  readonly scope: EntityIdScope;
};

/** The one outcome of an epoch comparison. Disagreement is never a denial. */
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

/**
 * Whether this key may act on that scope.
 *
 * The single comparison every participant makes before it opens a handle,
 * seals one, or hands stored mappings back.
 */
export const decideEpoch = (
  bound: EpochBoundScope,
  sealing: ServerSealingKey,
): EpochDecision =>
  bound.keyId === sealing.keyId
    ? Object.freeze({ _tag: "Agreed", sealing, scope: bound.scope })
    : EPOCH_UPDATE_REQUIRED;

/** Whether two epoch-bound scopes name the same realm under the same epoch. */
export const sameEpochScope = (
  left: EpochBoundScope,
  right: EpochBoundScope,
): boolean =>
  left.keyId === right.keyId &&
  left.scope.server === right.scope.server &&
  left.scope.principal === right.scope.principal &&
  left.scope.database === right.scope.database;

/**
 * Strict decode of the scope the Worker derived. It arrives over the
 * authenticated internal channel, so this is a shape check rather than an
 * authorization decision — but a malformed scope must never be silently
 * treated as "no scope", which would make every sealed handle undecodable and
 * every allocation unsealable.
 */
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

/**
 * A sanity cap on a caller-supplied handle, not a format decision. The v1
 * envelope is 55 characters; nothing that could plausibly be a future envelope
 * approaches this, so widening the codec never has to revisit it.
 */
const MAX_SEALED_TARGET_LENGTH = 4096;

/** What resolving one sealed target produced. Both failures are data-free. */
export type SealedTargetResolution =
  | { readonly _tag: "Resolved"; readonly eid: number }
  | { readonly _tag: "UpdateRequired" }
  | { readonly _tag: "Denied" };

const DENIED = Object.freeze({ _tag: "Denied" }) as SealedTargetResolution;
const UPDATE_REQUIRED = Object.freeze(
  { _tag: "UpdateRequired" },
) as SealedTargetResolution;

/**
 * Resolve one sealed target to its private eid.
 *
 * This is the whole resolver: a decrypt, bounded and scan-free. A handle
 * sealed for another server, principal, or database simply fails to
 * authenticate, so a wrong-scope handle is the ordinary denial with no
 * separate comparison to leak through.
 */
export const resolveSealedTarget = async (
  sealing: ServerSealingKey,
  scope: EntityIdScope,
  token: string,
): Promise<SealedTargetResolution> => {
  // Deliberately *not* an `isEntityId` shape check first. That predicate knows
  // only the v1 envelope length, and `openEntityId` reads the codec version
  // byte *before* it enforces any length — which is exactly what lets an older
  // build quarantine a handle minted by a newer codec instead of denying it. A
  // shape gate here would turn that promised `update-required` into a sealed
  // denial for every future envelope whose length changed, and a client whose
  // durable queue holds such handles would have no way back.
  //
  // The only bound is a sanity cap, far above any plausible envelope (v1 is 55
  // characters), so it can never participate in the version decision — it just
  // stops an absurd body from being base64-decoded.
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

/**
 * Walk a declared allocation path through a deployed output *shape* and report
 * whether it addresses an entity-reference position.
 *
 * The shape is what makes the binding real. A decoded `Ramose.EntityId` and a
 * decoded number are the same runtime value, so without this the declaration
 * `allocates: { issue: ["count"] }` would happily bind a durable client
 * identity to an ordinary integer.
 */
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

/** One slot resolved against the authoritative output, before sealing. */
export type AllocatedSlot = {
  readonly slot: string;
  readonly eid: number;
};

export type AllocationExtraction =
  | { readonly _tag: "Allocated"; readonly slots: readonly AllocatedSlot[] }
  /**
   * The operation declared a slot its own output does not deliver, or delivers
   * as an entity this transaction did not allocate. That is an operation
   * defect, not a caller error: the declaration is part of the pinned
   * {@link OperationVersion}, so a caller that pinned it was promised this
   * mapping.
   */
  | { readonly _tag: "Unallocated"; readonly slot: string };

/**
 * The entities this transaction allocated, by eid.
 *
 * A slot may only name one of these. `allocates` means exactly what it says:
 * the client minted a fresh {@link ClientRef} for an entity it intends to
 * *create*, and the mapping it gets back is durable and immutable, resolving
 * every later queued dependency. An operation that returned an entity it did
 * not allocate — `op.self`, an input ref, a literal eid — would silently bind
 * that fresh client identity to a pre-existing row and redirect all of the
 * client's subsequent offline writes onto it. Nothing after the commit can
 * repair that, so it is refused before one.
 *
 * Every entity an operation creates is staged under a tempid — the collector
 * generates one for `op.create` and `op.put`, and `op.tempid` names one
 * explicitly — so the report's resolved tempids are exactly the allocations.
 * An upsert that resolved a tempid to an existing row is included, and
 * correctly so: that is the entity the operation's own declaration named.
 */
export const allocatedEids = (
  tempids: Readonly<Record<string, number>>,
): ReadonlySet<number> => new Set(Object.values(tempids));

/**
 * Read every declared slot out of the exact JSON output the operation
 * materialized before its commit.
 *
 * Only the slots the *caller* bound to a client ref are read: an operation may
 * declare more slots than a given invocation cares about, and a slot nobody
 * bound produces no mapping and no failure.
 */
export const extractAllocations = (
  declared: readonly AllocationSlotDescriptor[],
  outputShape: OperationInputShape,
  output: unknown,
  requested: readonly InvocationAllocation[],
  /** Exactly the eids this transaction allocated — see {@link allocatedEids}. */
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
    // The entity has to be one this transaction allocated. A slot that named
    // `op.self`, an input ref, or a literal eid would bind the client's fresh,
    // immutable ClientRef to a pre-existing row.
    if (!allocated.has(value)) {
      return Object.freeze({ _tag: "Unallocated", slot: allocation.slot });
    }
    slots.push(Object.freeze({ slot: allocation.slot, eid: value }));
  }
  return Object.freeze({ _tag: "Allocated", slots: Object.freeze(slots) });
};

/* ── sealing entity references in client-visible output ───────────────────
 *
 * #417's output projection resolves every declared entity-reference position
 * to the private numeric eid, and the durable receipt stores exactly that. It
 * has to: the receipt is the replay, so its bytes are frozen at the commit and
 * are never rewritten, and the invocation digest and the exact-replay
 * comparison are over them.
 *
 * But the frozen contract is that no numeric eid crosses the operation
 * boundary. Both are satisfied by sealing at the *public projection* rather
 * than in the stored row: the receipt keeps the eids and stays byte-stable, and
 * the response carries the same opaque handle for that entity that an
 * allocation mapping and logical replication carry. Sealing is deterministic in
 * `(root, scope, eid)`, so an exact replay of a receipt written before this
 * existed projects the same handles as the commit that wrote it would have —
 * nothing stored needs a migration, and nothing stored is touched.
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Every entity-reference position the deployed output shape declares that the
 * materialized output actually fills with a resolved eid, in a stable
 * depth-first order.
 *
 * The *shape* decides, exactly as it does for an allocation slot: a resolved
 * `Ramose.EntityId` and an ordinary integer are the same runtime value, so a
 * walk over the value alone would seal counts and identifiers into handles.
 */
export const outputEntityRefPaths = (
  shape: OperationInputShape,
  output: unknown,
): readonly (readonly AllocationPathSegment[])[] => {
  const paths: (readonly AllocationPathSegment[])[] = [];
  const walk = (
    current: OperationInputShape,
    value: unknown,
    path: readonly AllocationPathSegment[],
  ): void => {
    switch (current._tag) {
      case "ref":
        // A ref position that does not hold a resolved eid never reached a
        // commit — the authoritative validator refuses it — so this is a
        // guard against a shape and a stored output that have drifted apart,
        // not a case with a meaning of its own.
        if (
          typeof value === "number" && Number.isSafeInteger(value) && value >= 0
        ) {
          paths.push(Object.freeze([...path]));
        }
        return;
      case "array":
        if (Array.isArray(value)) {
          for (let index = 0; index < value.length; index++) {
            walk(current.items, value[index], [...path, index]);
          }
        }
        return;
      case "struct":
        if (
          typeof value === "object" && value !== null && !Array.isArray(value)
        ) {
          for (const field of current.fields) {
            if (!Object.hasOwn(value, field.key)) continue;
            walk(
              field.shape,
              (value as Record<string, unknown>)[field.key],
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
  walk(shape, output, []);
  return Object.freeze(paths);
};

/**
 * Structurally replace the value at one declared entity-reference position.
 *
 * Shared by both directions: the public projection writes a sealed handle out,
 * and the authoritative edge writes a resolved eid in. The path always exists —
 * it came from a walk over this same value — so an absent one is an engine
 * defect and throws rather than inventing a position. The input is never
 * mutated; the caller's copy is the durable one.
 */
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

/**
 * Replace every entity-reference position of one output with its sealed
 * handle, structurally.
 *
 * The paths come from {@link outputEntityRefPaths} over this same value, so
 * each one exists; a path that does not is an engine defect and throws rather
 * than inventing a position. The input is never mutated — the caller's copy is
 * the durable one.
 */
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

/* ── sealed handles at declared input entity-ref positions (WR-17) ────────
 *
 * The structural twin of the output side above, run inbound instead of
 * outbound: {@link inputEntityRefHandles} finds the declared ref positions of
 * the *input* shape that hold a string, exactly as {@link outputEntityRefPaths}
 * finds the ones of the output shape that hold an eid, and
 * {@link resolveSealedInputRefs} replaces each through the same `replaceAt`.
 *
 * The target position and the input positions are then one mechanism: the same
 * scope opens them, the same epoch comparison gates them, and the same taxonomy
 * answers them. Only *declared* positions are opened — a handle-shaped string
 * anywhere else is data, never decrypted and never inspected, and reaches the
 * deployed codec exactly as it was submitted.
 * ──────────────────────────────────────────────────────────────────────── */

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/**
 * Whether one string could be a sealed handle minted by *some* codec version.
 *
 * Exactly the resolver's own floor, not a guess and not v1's length: the codec
 * owns {@link SEALED_ENTITY_ID_MIN_LENGTH} because it owns the frozen
 * `version ‖ keyId` preamble, and it denies anything shorter rather than
 * quarantining it. So a string this refuses is one `resolveSealedTarget` would
 * have denied — which is what makes the taxonomy at an input position
 * identical to the taxonomy at the target, including for a handle minted by a
 * codec whose envelope is shorter than v1's (**WR-17b**). A v1-length gate
 * here would be the shape gate **WR-10** forbids.
 */
const mayBeSealedEntityId = (value: string): boolean =>
  value.length >= SEALED_ENTITY_ID_MIN_LENGTH &&
  value.length <= MAX_SEALED_TARGET_LENGTH &&
  // Canonical unpadded base64url. A length congruent to 1 (mod 4) cannot encode
  // any byte string, so it is not canonical whatever its alphabet.
  value.length % 4 !== 1 &&
  BASE64URL.test(value);

/**
 * Whether this invocation input might carry a sealed handle at a position the
 * deployed operation declares as a ref.
 *
 * The Worker has to decide whether to derive the sealing scope *before* it can
 * see the deployed input shape, so it cannot ask the precise question. It asks
 * this one instead, over the raw JSON, and over-approximates: nothing is opened
 * because of the answer and nothing is refused because of it. The writer, which
 * does have the descriptor, then makes the only decision that matters —
 * {@link inputEntityRefHandles}.
 *
 * A false positive costs one isolate-cached root read. A false negative cannot
 * happen for anything a codec could have minted, which is what keeps the
 * `update-required` answer reachable for a handle from a newer codec (WR-17c).
 */
export const mayCarrySealedEntityId = (input: unknown): boolean => {
  // An explicit stack rather than recursion: this is the first thing the public
  // `/op` edge does with a caller-supplied body, and the caller chooses its
  // nesting depth. Everything downstream — the deployed codec, the canonical
  // digest — walks the same value, so this changes no limit; it just declines
  // to be the place a hostile body finds one.
  const seen = new Set<object>();
  const pending: unknown[] = [input];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string") {
      if (mayBeSealedEntityId(value)) return true;
      continue;
    }
    if (typeof value !== "object" || value === null) continue;
    // Request bodies are parsed JSON and therefore acyclic, but this walk is
    // reached from the public edge and must not depend on that.
    if (seen.has(value)) continue;
    seen.add(value);
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      pending.push(child);
    }
  }
  return false;
};

/**
 * Every position the deployed input shape declares as a ref that this exact
 * invocation input fills with a string, in a stable depth-first order.
 *
 * The precise question, asked where the descriptor is known. It decides whether
 * the epoch comparison runs at all, so an ordinary operation whose input merely
 * *looks* like it carries a handle is never dragged into one. A declared ref
 * holding a number is left out and keeps its previous path through the codec,
 * byte for byte.
 */
export const inputEntityRefHandles = (
  shape: OperationInputShape,
  input: unknown,
): readonly (readonly AllocationPathSegment[])[] => {
  const paths: (readonly AllocationPathSegment[])[] = [];
  const walk = (
    current: OperationInputShape,
    value: unknown,
    path: readonly AllocationPathSegment[],
  ): void => {
    switch (current._tag) {
      case "ref":
        if (typeof value === "string") paths.push(Object.freeze([...path]));
        return;
      case "array":
        if (Array.isArray(value)) {
          for (let index = 0; index < value.length; index++) {
            walk(current.items, value[index], [...path, index]);
          }
        }
        return;
      case "struct":
        if (
          typeof value === "object" && value !== null && !Array.isArray(value)
        ) {
          for (const field of current.fields) {
            if (!Object.hasOwn(value, field.key)) continue;
            walk(
              field.shape,
              (value as Record<string, unknown>)[field.key],
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
  walk(shape, input, []);
  return Object.freeze(paths);
};

/** What opening this invocation's declared input handles produced. */
export type SealedInputResolution =
  | { readonly _tag: "Resolved"; readonly input: unknown }
  | { readonly _tag: "UpdateRequired" }
  | { readonly _tag: "Denied" };

const DENIED_INPUT = Object.freeze({ _tag: "Denied" }) as SealedInputResolution;
const UPDATE_REQUIRED_INPUT = Object.freeze(
  { _tag: "UpdateRequired" },
) as SealedInputResolution;

/**
 * Open every sealed handle at a declared input entity-ref position and give
 * back the invocation input with private eids in their place.
 *
 * The returned input is what the #487 primitive digests, what the deployed
 * codec decodes, and what the replay fence's consumed refs are matched
 * against — so a sealed input and the numeric input naming the same entity are
 * the same invocation from here on (**WR-17a**).
 *
 * The paths come from {@link inputEntityRefHandles} over this same value, and
 * the replacement is the structural one the output projection uses, so every
 * key the shape does not describe survives untouched: the digest is over this
 * exact object. `UpdateRequired` wins over `Denied` when one invocation carries
 * both, for determinism only — both are effect-free and name no entity.
 */
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

/** One durable `{ clientRef, entityId }` mapping, sealed. */
export type SealedAllocationMapping = {
  readonly slot: string;
  readonly clientRef: string;
  readonly entityId: SealedEntityId;
};

/**
 * Seal every allocated eid into the public handle the receipt stores.
 *
 * Sealing is deterministic in `(root, scope, eid)`, so an exact replay of a
 * completed receipt returns byte-identical handles without re-executing — and
 * a handle minted here is the same handle logical replication carries for the
 * same entity in the same scope.
 */
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
