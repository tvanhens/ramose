import { proposedReadView } from "./read-filter.ts";
import * as Effect from "effect/Effect";
import { InvalidRequest, TxRejected, Unauthorized } from "../../db/Errors.ts";
import { Connection } from "../core/conn.ts";
import { Index, ValueTag, type Datom } from "../core/datom.ts";
import { DB_TX_INSTANT, isTxEid, txEid } from "../core/schema.ts";
import { fromJson, stringifyJson } from "../core/json.ts";
import { constructAuthorizedRequestContext, type AuthenticatedCaller, type AuthorizedRequestContext } from "./request.ts";
import {
  authorizeCatalogOperation,
  deployedOperationVersion,
  executeCatalogOperation,
  resolveOperationCatalog,
  type OperationInvocation,
  type OperationRuntime,
} from "./operations-runtime.ts";

export const MAX_CHANGESET_OPERATIONS = 100;
export const MAX_CHANGESET_DATOMS = 10_000;
export const MAX_CHANGESET_BYTES = 1_000_000;

export type ChangesetStep = {
  readonly invocation: Omit<OperationInvocation, "caller">;
  readonly datoms: readonly Datom[];
};

export type StoredChangeset = {
  readonly id: string;
  readonly revision: string;
  readonly reviewers?: readonly string[] | undefined;
  readonly requestKey?: string;
  readonly parentRevision?: string;
  readonly title: string;
  readonly subject: string;
  readonly basis: number;
  readonly nextEntityId: number;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly steps: readonly ChangesetStep[];
  readonly datoms: readonly Datom[];
  readonly status: "draft" | "committed" | "discarded";
  readonly committedAt?: number;
  readonly committedBy?: string;
};

export const decodeStoredChangeset = (value: StoredChangeset): StoredChangeset => ({
  ...value,
  datoms: fromJson(value.datoms) as readonly Datom[],
  steps: value.steps.map((step) => ({
    ...step,
    datoms: fromJson(step.datoms) as readonly Datom[],
    invocation: { ...step.invocation, ...(step.invocation.target === undefined ? {} : {
      target: fromJson(step.invocation.target) as NonNullable<OperationInvocation["target"]>,
    }) },
  })),
});

export const changesetConflict = (code: string): TxRejected =>
  new TxRejected({ message: code, code });

export const changesetSubject = (caller: AuthenticatedCaller, now: number): string => {
  const subject = caller.claims.sub;
  if (typeof subject !== "string" || subject.length === 0 ||
    !Number.isSafeInteger(caller.exp) || caller.exp * 1000 <= now) {
    throw new Unauthorized({});
  }
  return subject;
};

const factKey = (d: Datom): string => stringifyJson([d.e, d.a, d.vt, d.v]);

export const collapseChangeset = async (
  base: Connection,
  steps: readonly ChangesetStep[],
  now: number,
): Promise<readonly Datom[]> => {
  const last = new Map<string, Datom>();
  for (const step of steps) {
    for (const d of step.datoms) if (!isTxEid(d.e)) last.set(factKey(d), d);
  }
  const t = base.t + 1;
  const result: Datom[] = [{ e: txEid(t), a: DB_TX_INSTANT, vt: ValueTag.Inst, v: now, t, op: true }];
  for (const d of last.values()) {
    const prior = await base.db().first(Index.EAVT, { e: d.e, a: d.a, vt: d.vt, v: d.v });
    if ((prior !== undefined) !== d.op) result.push({ ...d, t });
  }
  return result;
};

export const prepareChangeset = async (
  base: Connection,
  runtime: OperationRuntime,
  input: { readonly id: string; readonly title: string; readonly operations: readonly OperationInvocation[] },
  caller: AuthenticatedCaller,
): Promise<StoredChangeset> => {
  if (input.operations.length < 1 || input.operations.length > MAX_CHANGESET_OPERATIONS) {
    throw new InvalidRequest({ message: "a changeset needs between 1 and 100 operations" });
  }
  const now = runtime.now();
  const subject = changesetSubject(caller, now);
  const draft = base.fork();
  const steps: ChangesetStep[] = [];
  let count = 0;
  for (const invocation of input.operations) {
    const resolved = await Effect.runPromise(resolveOperationCatalog(runtime, invocation));
    const version = deployedOperationVersion(resolved, invocation.owner, invocation.localName);
    if (version === undefined || invocation.operationVersion !== version) {
      throw changesetConflict("operation_changed");
    }
    const executed = await executeCatalogOperation(draft, runtime, { ...invocation, caller });
    executed.assertFresh();
    count += executed.report.txData.length;
    if (count > MAX_CHANGESET_DATOMS) throw changesetConflict("changeset_too_large");
    const { caller: _caller, ...transaction } = invocation;
    steps.push({ invocation: transaction, datoms: executed.report.txData });
  }
  const result: StoredChangeset = {
    id: input.id,
    title: input.title,
    revision: crypto.randomUUID(),
    subject,
    basis: base.t,
    nextEntityId: draft.nextEntityId,
    createdAt: now,
    expiresAt: now + 24 * 60 * 60 * 1000,
    steps,
    datoms: await collapseChangeset(base, steps, now),
    status: "draft",
  };
  if (new TextEncoder().encode(stringifyJson(result)).byteLength > MAX_CHANGESET_BYTES) throw changesetConflict("changeset_too_large");
  return result;
};

export const authorizeChangeset = async (
  base: Connection,
  runtime: OperationRuntime,
  stored: StoredChangeset,
  caller: AuthenticatedCaller,
): Promise<Connection> => {
  const subject = changesetSubject(caller, runtime.now());
  if (subject !== stored.subject && !stored.reviewers?.includes(subject)) throw new Unauthorized({});
  if (stored.expiresAt <= runtime.now()) throw changesetConflict("changeset_expired");
  if (base.t !== stored.basis) throw changesetConflict("changeset_stale");
  const draft = base.fork();
  for (const step of stored.steps) {
    const invocation = { ...step.invocation, caller };
    const resolved = await Effect.runPromise(resolveOperationCatalog(runtime, invocation));
    if (deployedOperationVersion(resolved, invocation.owner, invocation.localName) !== invocation.operationVersion) {
      throw changesetConflict("operation_changed");
    }
    await authorizeCatalogOperation(draft, runtime, invocation, resolved);
    draft.applyDatoms(step.datoms);
  }
  changesetSubject(caller, runtime.now());
  return draft;
};

export const appendChangeset = async (
  base: Connection,
  runtime: OperationRuntime,
  stored: StoredChangeset,
  operations: readonly OperationInvocation[],
  caller: AuthenticatedCaller,
): Promise<StoredChangeset> => {
  if (stored.steps.length + operations.length > MAX_CHANGESET_OPERATIONS) throw changesetConflict("changeset_too_large");
  const draft = await authorizeChangeset(base, runtime, stored, caller);
  const appended = await prepareChangeset(draft, runtime, { id: stored.id, title: stored.title, operations }, caller);
  const steps = [...stored.steps, ...appended.steps];
  if (steps.reduce((count, step) => count + step.datoms.length, 0) > MAX_CHANGESET_DATOMS) throw changesetConflict("changeset_too_large");
  const result = { ...appended, subject: stored.subject, reviewers: stored.reviewers, createdAt: stored.createdAt, expiresAt: stored.expiresAt, basis: stored.basis, steps,
    datoms: await collapseChangeset(base, steps, runtime.now()) };
  if (new TextEncoder().encode(stringifyJson(result)).byteLength > MAX_CHANGESET_BYTES) throw changesetConflict("changeset_too_large");
  return result;
};

export type ChangesetFact = {
  readonly entity: number;
  readonly field: string;
  readonly value: unknown;
  readonly reference: boolean;
  readonly added: boolean;
};

export const changesetReadContext = async (
  base: Connection,
  runtime: OperationRuntime,
  stored: StoredChangeset,
  caller: AuthenticatedCaller,
  draft: Connection,
  live: Connection = base,
): Promise<{ readonly before: AuthorizedRequestContext; readonly after: AuthorizedRequestContext }> => {
  const invocation = stored.steps[0]!.invocation;
  const context = (connection: Connection) => Effect.runPromise(constructAuthorizedRequestContext({
    authenticate: Effect.succeed(caller), catalogs: runtime.catalogs.catalogs,
    routeDatabase: invocation.database, catalogKey: invocation.catalogKey, unitHash: invocation.unitHash,
    currentDb: () => Effect.succeed(connection.db()),
  }, caller));
  const historical = await context(base);
  const current = await context(live);
  const before = { ...historical, filteredDb: proposedReadView(historical, historical, current) };
  const after = await context(draft);
  return { before, after: { ...after, filteredDb: proposedReadView(before, after, current) } };
};

export const changesetDiff = async (
  base: Connection,
  runtime: OperationRuntime,
  stored: StoredChangeset,
  caller: AuthenticatedCaller,
  live: Connection = base,
): Promise<readonly ChangesetFact[]> => {
  const draft = await authorizeChangeset(base, runtime, stored, caller);
  const { before, after } = await changesetReadContext(base, runtime, stored, caller, draft, live);
  const facts: ChangesetFact[] = [];
  for (const d of stored.datoms) {
    if (isTxEid(d.e)) continue;
    const view = d.op ? after.filteredDb : before.filteredDb;
    if (await view.first(Index.EAVT, { e: d.e, a: d.a, vt: d.vt, v: d.v }) === undefined) continue;
    const attr = view.attr(d.a);
    if (attr === undefined) continue;
    facts.push({ entity: d.e, field: attr.ident, value: d.v, reference: d.vt === ValueTag.Ref, added: d.op });
  }
  changesetSubject(caller, runtime.now());
  return facts;
};
