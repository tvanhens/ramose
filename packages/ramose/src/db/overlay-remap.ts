/**
 * Overlay remapping reaction: acknowledged named tempids rewritten through
 * queued tx tuples, invocations, and `/op` input paths. Sync only — overlay
 * owns orchestration; this module is the data transform.
 *
 * @internal
 */

import { type Datom, ValueTag } from "../internal/core/datom.ts";
import type { Schema } from "../internal/core/schema.ts";
import { TxError } from "../internal/core/tx.ts";
import { isBuilderTempidName } from "./entityArg.ts";
import type { OperationInvocation } from "./Operation.ts";

/** Pending overlay layer fields the remapper mutates. */
export interface OverlayRemapLayer {
  tx: unknown[];
  invocation?: OperationInvocation;
  tempids: Record<string, number>;
  generated: Set<string>;
  usedTempids: Set<string>;
  inputPaths: (readonly (string | number)[])[];
  datoms?: Datom[];
}

/** No-layer outbox record (local CAS-bypass) still waiting on an ack. */
export interface OverlayInFlightRecord {
  names: Set<string>;
  usedTempids: Set<string>;
  inputPaths: (readonly (string | number)[])[];
  tx: unknown[];
  invocation?: OperationInvocation;
}

const remapEntityRef = (
  entity: unknown,
  eids: Map<number, number>,
  referred: Record<string, number>,
): unknown => {
  if (typeof entity === "number") return eids.get(entity) ?? entity;
  if (typeof entity === "string" && referred[entity] !== undefined) {
    return referred[entity];
  }
  // Lookups (`[":user/name", "Ada"]`) are identity-based — pass through.
  return entity;
};

const rewriteTempid = (value: unknown, ids: Record<string, number>): unknown =>
  typeof value === "string" && ids[value] !== undefined ? ids[value] : value;

const isLookupRef = (value: unknown): value is readonly [string, unknown] =>
  Array.isArray(value) &&
  value.length === 2 &&
  typeof value[0] === "string" &&
  value[0].startsWith(":");

const forwardIdent = (ident: string): string => {
  const slash = ident.lastIndexOf("/");
  return slash >= 0 && ident[slash + 1] === "_"
    ? ident.slice(0, slash + 1) + ident.slice(slash + 2)
    : ident;
};

const isRefAttr = (schema: Schema | undefined, a: unknown): boolean => {
  if (schema === undefined) return false;
  if (typeof a === "number") return schema.attr(a)?.valueType === ValueTag.Ref;
  if (typeof a !== "string") return false;
  return schema.attr(forwardIdent(a))?.valueType === ValueTag.Ref;
};

/** Rewrite a tempid only in entity / ref positions — never a scalar like a title. */
const rewriteEntityForm = (
  value: unknown,
  ids: Record<string, number>,
  schema: Schema | undefined,
): unknown => {
  if (isLookupRef(value)) return value;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return rewriteMap(value as Record<string, unknown>, ids, schema);
  }
  return rewriteTempid(value, ids);
};

const rewriteMap = (
  m: Record<string, unknown>,
  ids: Record<string, number>,
  schema: Schema | undefined,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(m)) {
    if (k === ":db/id") {
      out[k] = rewriteEntityForm(v, ids, schema);
    } else if (isRefAttr(schema, k)) {
      out[k] = Array.isArray(v) && !isLookupRef(v)
        ? v.map((x) => rewriteEntityForm(x, ids, schema))
        : rewriteEntityForm(v, ids, schema);
    } else {
      out[k] = v;
    }
  }
  return out;
};

/** @internal Pending-layer tempid rewrite. Tests pin `:db/update` and `:db/cas`. */
export const rewritePendingTx = (
  tx: readonly unknown[],
  ids: Record<string, number>,
  schema: Schema | undefined,
): unknown[] => rewriteTx(tx, ids, schema);

const ATTR_OPS = new Set([":db/add", ":db/retract", ":db/update", ":db/cas"]);

/** Subject + every value slot after the attr, rewritten when the attr is a ref. */
const rewriteAttrOp = (
  item: readonly unknown[],
  ids: Record<string, number>,
  schema: Schema | undefined,
): unknown[] => {
  const [op, e, a, ...values] = item;
  const next: unknown[] = [op, rewriteEntityForm(e, ids, schema)];
  if (item.length >= 3) next.push(a);
  // CAS value slots are entity forms when the attr is a ref (or schema is
  // unknown — do not drop a rewrite that would allocate a different entity).
  const rewriteValues =
    op === ":db/cas"
      ? schema === undefined || isRefAttr(schema, a)
      : isRefAttr(schema, a);
  for (const v of values) {
    next.push(rewriteValues ? rewriteEntityForm(v, ids, schema) : v);
  }
  return next;
};

const rewriteTx = (
  tx: readonly unknown[],
  ids: Record<string, number>,
  schema: Schema | undefined,
): unknown[] =>
  tx.map((item) => {
    if (Array.isArray(item)) {
      const [op] = item as unknown[];
      if (op === ":db/retractEntity") {
        return [op, rewriteEntityForm(item[1], ids, schema)];
      }
      if (typeof op === "string" && ATTR_OPS.has(op)) {
        return rewriteAttrOp(item, ids, schema);
      }
      return item;
    }
    if (item !== null && typeof item === "object") {
      return rewriteMap(item as Record<string, unknown>, ids, schema);
    }
    return item;
  });

const isNamedTempid = (value: unknown): value is string =>
  typeof value === "string" && !value.startsWith(":") && !isBuilderTempidName(value);

const collectNamedFromValue = (
  value: unknown,
  names: Set<string>,
  schema: Schema | undefined,
  asRef: boolean,
): void => {
  if (isLookupRef(value)) return;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    collectNamedFromMap(value as Record<string, unknown>, names, schema);
    return;
  }
  if (Array.isArray(value) && asRef) {
    for (const x of value) collectNamedFromValue(x, names, schema, true);
    return;
  }
  if (asRef && isNamedTempid(value)) names.add(value);
};

const collectNamedFromMap = (
  m: Record<string, unknown>,
  names: Set<string>,
  schema: Schema | undefined,
): void => {
  for (const [k, v] of Object.entries(m)) {
    if (k === ":db/id" || isRefAttr(schema, k)) {
      collectNamedFromValue(v, names, schema, true);
    }
  }
};

/** Named tempids a tx still refers to — subjects, CAS value slots, ref values. */
export const collectNamedTempids = (
  tx: readonly unknown[],
  schema: Schema | undefined,
  extra?: { readonly tempids?: Record<string, number>; readonly entity?: unknown },
): Set<string> => {
  const names = new Set<string>();
  for (const item of tx) {
    if (Array.isArray(item)) {
      const [op, e, a, ...values] = item as unknown[];
      if (op === ":db/retractEntity") {
        collectNamedFromValue(e, names, schema, true);
        continue;
      }
      if (typeof op === "string" && ATTR_OPS.has(op)) {
        collectNamedFromValue(e, names, schema, true);
        const asRef = op === ":db/cas" ? schema === undefined || isRefAttr(schema, a) : isRefAttr(schema, a);
        for (const v of values) collectNamedFromValue(v, names, schema, asRef);
      }
      continue;
    }
    if (item !== null && typeof item === "object") {
      collectNamedFromMap(item as Record<string, unknown>, names, schema);
    }
  }
  if (extra?.tempids !== undefined) {
    for (const k of Object.keys(extra.tempids)) {
      if (isNamedTempid(k)) names.add(k);
    }
  }
  if (isNamedTempid(extra?.entity)) names.add(extra.entity);
  return names;
};

const getAtPath = (
  value: unknown,
  path: readonly (string | number)[],
): unknown => {
  let cur = value;
  for (const key of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string | number, unknown>)[key];
  }
  return cur;
};

const setAtPath = (
  value: unknown,
  path: readonly (string | number)[],
  next: unknown,
): unknown => {
  if (path.length === 0) return next;
  const [head, ...rest] = path;
  if (Array.isArray(value)) {
    const out = value.slice();
    const i = Number(head);
    out[i] = setAtPath(out[i], rest, next);
    return out;
  }
  if (value !== null && typeof value === "object") {
    return {
      ...(value as Record<string, unknown>),
      [head as string]: setAtPath(
        (value as Record<string, unknown>)[head as string],
        rest,
        next,
      ),
    };
  }
  return value;
};

/** Rewrite only the input paths the body treated as tempids / entity refs. */
const rewriteInputPaths = (
  input: unknown,
  paths: readonly (readonly (string | number)[])[],
  ids: Record<string, number>,
): unknown => {
  let out = input;
  for (const path of paths) {
    const cur = getAtPath(out, path);
    if (typeof cur === "string" && ids[cur] !== undefined) {
      out = setAtPath(out, path, ids[cur]);
    }
  }
  return out;
};

/**
 * Deep proxy that records every string leaf the body reads. Those paths
 * are the only input slots that may be remapped — a title that equals a
 * tempid name is left alone if the body never used it as an entity.
 */
const trackInputReads = (
  value: unknown,
  onRead: (path: readonly (string | number)[], leaf: unknown) => void,
  path: readonly (string | number)[] = [],
): unknown => {
  if (value === null || typeof value !== "object") return value;
  if (isLookupRef(value)) return value;
  if (Array.isArray(value)) {
    return new Proxy(value, {
      get(target, prop, recv) {
        if (typeof prop === "symbol" || prop === "length") {
          return Reflect.get(target, prop, recv);
        }
        const i = Number(prop);
        if (!Number.isInteger(i)) return Reflect.get(target, prop, recv);
        const item = target[i];
        if (item === null || typeof item !== "object") {
          onRead([...path, i], item);
          return item;
        }
        return trackInputReads(item, onRead, [...path, i]);
      },
    });
  }
  return new Proxy(value as object, {
    get(target, prop, recv) {
      if (typeof prop === "symbol") return Reflect.get(target, prop, recv);
      const item = Reflect.get(target, prop, recv);
      if (item === null || typeof item !== "object") {
        onRead([...path, prop], item);
        return item;
      }
      return trackInputReads(item, onRead, [...path, prop]);
    },
  });
};

/**
 * Track which input leaves an operation body reads as named tempids.
 * `input` is the proxied value to pass into `runBody`.
 */
export const collectOpInputTempidPaths = (
  input: unknown,
): { input: unknown; paths: (readonly (string | number)[])[] } => {
  const paths: (readonly (string | number)[])[] = [];
  const tracked = trackInputReads(input, (path, leaf) => {
    if (isNamedTempid(leaf)) paths.push(path);
  });
  return { input: tracked, paths };
};

const usedIds = (
  ids: Record<string, number>,
  used: Set<string>,
): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const [name, eid] of Object.entries(ids)) {
    if (used.has(name)) out[name] = eid;
  }
  return out;
};

/**
 * Remap `invocation.entity`, only `inputPaths` whose current string is in
 * the acked named map, and merge used named tempids onto `tempids`.
 */
export const rewritePendingInvocation = (
  invocation: OperationInvocation,
  ids: Record<string, number>,
  eids: Map<number, number>,
  used: Set<string>,
  inputPaths: readonly (readonly (string | number)[])[] = [],
): OperationInvocation => {
  const relevant = usedIds(ids, used);
  const entity =
    invocation.entity !== undefined
      ? remapEntityRef(invocation.entity, eids, ids)
      : undefined;
  const input =
    Object.keys(relevant).length > 0 && inputPaths.length > 0
      ? rewriteInputPaths(invocation.input, inputPaths, relevant)
      : invocation.input;
  const nextTempids: Record<string, number> = {
    ...(invocation.tempids ?? {}),
    ...relevant,
  };
  const tempids =
    Object.keys(nextTempids).length > 0 ? nextTempids : undefined;
  if (
    entity === invocation.entity &&
    input === invocation.input &&
    tempids === invocation.tempids
  ) {
    return invocation;
  }
  return {
    ...invocation,
    input,
    ...(entity !== undefined ? { entity } : {}),
    ...(tempids !== undefined ? { tempids } : {}),
  };
};

const txHasCas = (tx: readonly unknown[]): boolean => {
  for (const item of tx) {
    if (Array.isArray(item) && item[0] === ":db/cas") return true;
  }
  return false;
};

const errorCode = (err: unknown): string | undefined => {
  if (err instanceof TxError) return err.code;
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
};

/**
 * Whether a local `processTx` failure should still POST — the server may
 * see a fresher entity. Replica-state CAS / missing CAS subjects submit;
 * other local rejections stay fail-closed.
 */
export const submitDespiteLocalTxError = (
  err: unknown,
  tx: readonly unknown[],
): boolean => {
  const code = errorCode(err);
  if (code === "tx/cas-conflict") return true;
  if (
    (code === "tx/missing-entity" || code === "tx/lookup-ref") &&
    txHasCas(tx)
  ) {
    return true;
  }
  return false;
};

const rewriteEid = (e: number, eids: Map<number, number>): number =>
  eids.get(e) ?? e;

const rewriteDatoms = (datoms: readonly Datom[], eids: Map<number, number>): Datom[] => {
  if (eids.size === 0) return datoms as Datom[];
  return datoms.map((d) => {
    const e = rewriteEid(d.e, eids);
    const v =
      typeof d.v === "number" && eids.has(d.v) ? eids.get(d.v)! : d.v;
    return e === d.e && v === d.v ? d : { ...d, e, v };
  });
};

/**
 * Drop acked names that no pending / in-flight layer still refers to.
 */
export const pruneAckedNamedIds = (
  ackedNamed: Record<string, number>,
  pending: readonly OverlayRemapLayer[],
  inFlight: readonly OverlayInFlightRecord[],
  schema?: Schema,
): void => {
  const needed = new Set<string>();
  for (const layer of pending) {
    for (const name of collectNamedTempids(layer.tx, schema, {
      tempids: layer.tempids,
      ...(layer.invocation?.entity !== undefined
        ? { entity: layer.invocation.entity }
        : {}),
    })) {
      needed.add(name);
    }
    for (const name of layer.usedTempids) needed.add(name);
    if (layer.invocation?.tempids !== undefined) {
      for (const name of Object.keys(layer.invocation.tempids)) needed.add(name);
    }
  }
  for (const rec of inFlight) {
    for (const name of rec.names) needed.add(name);
    for (const name of rec.usedTempids) needed.add(name);
  }
  for (const name of Object.keys(ackedNamed)) {
    if (!needed.has(name)) delete ackedNamed[name];
  }
};

/**
 * Remap queued pending layers and in-flight no-layer records after an ack.
 * Mutates `ackedNamed` (named / non-`tmp-N` names stored) then prunes.
 */
export const remapQueuedLayers = (
  pending: OverlayRemapLayer[],
  inFlight: OverlayInFlightRecord[],
  ackedNamed: Record<string, number>,
  acked: Record<string, number>,
  local: Record<string, number>,
  schema?: Schema,
): void => {
  const eids = new Map<number, number>();
  for (const [tmp, serverEid] of Object.entries(acked)) {
    const was = local[tmp];
    if (typeof was === "number") eids.set(was, serverEid);
  }
  const referred: Record<string, number> = {};
  for (const [tmp, serverEid] of Object.entries(acked)) {
    referred[tmp] = serverEid;
    // Named (non-generated) tempids are shareable across queued txs.
    if (!isBuilderTempidName(tmp)) ackedNamed[tmp] = serverEid;
  }
  for (const layer of pending) {
    const foreign: Record<string, number> = {};
    for (const [tmp, serverEid] of Object.entries(referred)) {
      // Generated `tmp-N` is per-builder. A named tempid is shared even
      // if local processTx also allocated it (CAS subject / ref slot).
      if (layer.tempids[tmp] === undefined || !layer.generated.has(tmp)) {
        foreign[tmp] = serverEid;
      }
    }
    if (Object.keys(foreign).length > 0) {
      layer.tx = rewriteTx(layer.tx, foreign, schema);
    }
    if (layer.invocation !== undefined) {
      layer.invocation = rewritePendingInvocation(
        layer.invocation,
        foreign,
        eids,
        layer.usedTempids,
        layer.inputPaths,
      );
    }
    if (layer.datoms !== undefined) {
      layer.datoms = rewriteDatoms(layer.datoms, eids);
    }
    for (const [tmp, e] of Object.entries(layer.tempids)) {
      layer.tempids[tmp] = eids.get(e) ?? e;
    }
  }
  for (const rec of inFlight) {
    rec.tx = rewriteTx(rec.tx, referred, schema);
    if (rec.invocation !== undefined) {
      rec.invocation = rewritePendingInvocation(
        rec.invocation,
        referred,
        eids,
        rec.usedTempids,
        rec.inputPaths,
      );
    }
  }
  pruneAckedNamedIds(ackedNamed, pending, inFlight, schema);
};
