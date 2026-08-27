/**
 * Opaque raw, rule, and authorized application snapshots (TCB-1–TCB-4).
 *
 * Distinct classes with module-private constructors. They are not subtypes
 * of one another or of physical `Db`. Inheritance, casts, public
 * constructors, and generic `Db` passing must not recover a more privileged
 * capability. Effect Context tags are not this boundary.
 *
 * Privileged storage handles stay in WeakMaps. A forged object that is
 * merely typed as a snapshot cannot yield a physical `Db`.
 *
 * Unchecked factories stay module-private. Callers mint capabilities only
 * through {@link mintRawSnapshot}, {@link mintRuleSnapshot}, and
 * {@link mintAuthorizedSnapshot}. Rule and authorized minting require a
 * sealed admission ticket. Rule projection never exports the physical
 * `Db`; the evaluator uses lease-checked, bounded operations.
 *
 * @internal
 */

import type { Db } from "../../core/db.ts";
import { CatalogMismatch, InvalidIR, LeaseExpired } from "../failures.ts";
import { DEFAULT_AUTHORIZATION_BUDGET } from "../bounds.ts";
import type { CatalogDescriptor, FieldDescriptor } from "../catalog.ts";
import type { CatalogId, CatalogVersion, DatabaseId, FieldId, PolicyHash } from "../identities.ts";
import { isVerifiedInstalledAuthorization } from "../install.ts";
import type { InstalledAuthorizationIRV1 } from "../ir.ts";
import type { AuthorizationPrincipal } from "../principal.ts";
import type { Projected } from "../truth.ts";
import * as Result from "effect/Result";
import {
  isVerifiedAdmissionTicket,
  type AdmissionTicket,
} from "./authentication.ts";
import {
  collapseApplicationBasis,
  mergeSnapshotBases,
  type SnapshotBases,
} from "./basis.ts";
import {
  ApplicationSnapshotUnavailable,
  AuthenticationRejected,
  RawStorageUnavailable,
  RuleSnapshotUnavailable,
  SnapshotCancelled,
  type ApplicationSnapshotFailure,
  type RawStorageFailure,
  type RuleSnapshotFailure,
} from "./failures.ts";
import { freezePrincipal } from "./principal-freeze.ts";
import {
  cancelLease,
  checkLease,
  createLeaseState,
  inspectLease,
  type SnapshotLeaseState,
} from "./lease.ts";
import {
  fieldDescriptorKey,
  fieldStorageIndex,
  physicalStorageIdent,
  traversalCompositionsOf,
} from "./field-index.ts";
import {
  projectFieldFromDb,
  traverseFieldsFromDb,
  traverseFromMeFromDb,
  type FieldProjectionIndex,
} from "./projection.ts";

export type AuthorizationBudgetState = {
  readonly limit: number;
  spent: number;
};

type RawState = {
  readonly database: DatabaseId;
  readonly current: Db;
  readonly view: Db;
  readonly lease: SnapshotLeaseState;
  readonly application: ReturnType<typeof collapseApplicationBasis>;
};

type RuleProjectionState = {
  readonly database: DatabaseId;
  readonly catalog: CatalogId;
  readonly catalogVersion: CatalogVersion;
  readonly policyHash: PolicyHash;
  readonly basisT: number;
  readonly principal: AuthorizationPrincipal;
  readonly installed: InstalledAuthorizationIRV1;
  readonly index: FieldProjectionIndex;
  readonly current: Db;
  readonly lease: SnapshotLeaseState;
  readonly budget: AuthorizationBudgetState;
};

type AuthorizedState = {
  readonly database: DatabaseId;
  readonly catalog: CatalogId;
  readonly catalogVersion: CatalogVersion;
  readonly policyHash: PolicyHash;
  readonly principal: AuthorizationPrincipal;
  readonly installed: InstalledAuthorizationIRV1;
  readonly bases: SnapshotBases;
  readonly lease: SnapshotLeaseState;
};

const rawStates = new WeakMap<RawSnapshot, RawState>();
const ruleStates = new WeakMap<RuleSnapshot, RuleProjectionState>();
const authorizedStates = new WeakMap<AuthorizedSnapshot, AuthorizedState>();

let constructRaw: (state: RawState) => RawSnapshot;
let constructRule: (state: RuleProjectionState) => RuleSnapshot;
let constructAuthorized: (state: AuthorizedState) => AuthorizedSnapshot;

/** Privileged facts at a named basis. Storage, transactor, indexer only. */
export class RawSnapshot {
  readonly kind = "raw" as const;
  readonly database: DatabaseId;
  readonly basisT: number;
  readonly asOfT: number | undefined;
  readonly history: boolean;
  readonly effectiveT: number;
  readonly leaseEpoch: number;

  private constructor(state: RawState) {
    this.database = state.database;
    this.basisT = state.application.basisT;
    this.asOfT = state.application.asOfT;
    this.history = state.application.history;
    this.effectiveT = state.application.effectiveT;
    this.leaseEpoch = state.lease.epoch;
    rawStates.set(this, state);
    Object.freeze(this);
  }

  static {
    constructRaw = (state) => new RawSnapshot(state);
  }
}

/** Trusted current rule basis for grant and traversal lookup. */
export class RuleSnapshot {
  readonly kind = "rule" as const;
  readonly database: DatabaseId;
  readonly catalog: CatalogId;
  readonly catalogVersion: CatalogVersion;
  readonly policyHash: PolicyHash;
  readonly basisT: number;
  readonly leaseEpoch: number;

  private constructor(state: RuleProjectionState) {
    this.database = state.database;
    this.catalog = state.catalog;
    this.catalogVersion = state.catalogVersion;
    this.policyHash = state.policyHash;
    this.basisT = state.basisT;
    this.leaseEpoch = state.lease.epoch;
    ruleStates.set(this, state);
    Object.freeze(this);
  }

  static {
    constructRule = (state) => new RuleSnapshot(state);
  }
}

/**
 * Principal-filtered application snapshot. The sole handle query / pull /
 * live / session may see. Until the authorized datom cursor lands (#367),
 * the cursor yields no application datoms (FC-2).
 */
export class AuthorizedSnapshot {
  readonly kind = "authorized" as const;
  readonly database: DatabaseId;
  readonly catalog: CatalogId;
  readonly catalogVersion: CatalogVersion;
  readonly policyHash: PolicyHash;
  readonly principal: AuthorizationPrincipal;
  readonly basisT: number;
  readonly asOfT: number | undefined;
  readonly history: boolean;
  readonly effectiveT: number;
  readonly ruleBasisT: number;
  readonly leaseEpoch: number;

  private constructor(state: AuthorizedState) {
    this.database = state.database;
    this.catalog = state.catalog;
    this.catalogVersion = state.catalogVersion;
    this.policyHash = state.policyHash;
    this.principal = state.principal;
    this.basisT = state.bases.application.basisT;
    this.asOfT = state.bases.application.asOfT;
    this.history = state.bases.application.history;
    this.effectiveT = state.bases.application.effectiveT;
    this.ruleBasisT = state.bases.ruleBasisT;
    this.leaseEpoch = state.lease.epoch;
    authorizedStates.set(this, state);
    Object.freeze(this);
  }

  static {
    constructAuthorized = (state) => new AuthorizedSnapshot(state);
  }
}

const deadLease = (epoch: number) => ({ epoch, expiresAt: 0, cancelled: true as const });

const notLive = (): SnapshotCancelled =>
  new SnapshotCancelled({ message: "snapshot is not a live capability" });

const liveRawState = (snapshot: RawSnapshot, now?: number): RawState | undefined => {
  const state = rawStates.get(snapshot);
  if (state === undefined) return undefined;
  if (Result.isFailure(checkLease(state.lease, now))) return undefined;
  return state;
};

export const inspectRawSnapshot = (
  snapshot: RawSnapshot,
): {
  readonly database: DatabaseId;
  readonly basisT: number;
  readonly asOfT: number | undefined;
  readonly history: boolean;
  readonly effectiveT: number;
  readonly leaseEpoch: number;
  readonly cancelled: boolean;
  readonly expiresAt: number;
} => {
  const state = rawStates.get(snapshot);
  const lease = state === undefined ? deadLease(snapshot.leaseEpoch) : inspectLease(state.lease);
  const application = state?.application;
  return {
    database: state?.database ?? snapshot.database,
    basisT: application?.basisT ?? snapshot.basisT,
    asOfT: application?.asOfT ?? snapshot.asOfT,
    history: application?.history ?? snapshot.history,
    effectiveT: application?.effectiveT ?? snapshot.effectiveT,
    leaseEpoch: snapshot.leaseEpoch,
    cancelled: lease.cancelled,
    expiresAt: lease.expiresAt,
  };
};

export const inspectRuleSnapshot = (
  snapshot: RuleSnapshot,
): {
  readonly database: DatabaseId;
  readonly catalog: CatalogId;
  readonly catalogVersion: CatalogVersion;
  readonly policyHash: PolicyHash;
  readonly basisT: number;
  readonly leaseEpoch: number;
  readonly cancelled: boolean;
  readonly expiresAt: number;
  readonly budget: { readonly limit: number; readonly spent: number };
} => {
  const state = ruleStates.get(snapshot);
  const lease = state === undefined ? deadLease(snapshot.leaseEpoch) : inspectLease(state.lease);
  return {
    database: state?.database ?? snapshot.database,
    catalog: state?.catalog ?? snapshot.catalog,
    catalogVersion: state?.catalogVersion ?? snapshot.catalogVersion,
    policyHash: state?.policyHash ?? snapshot.policyHash,
    basisT: state?.basisT ?? snapshot.basisT,
    leaseEpoch: snapshot.leaseEpoch,
    cancelled: lease.cancelled,
    expiresAt: lease.expiresAt,
    budget: state === undefined ? { limit: 0, spent: 0 } : { limit: state.budget.limit, spent: state.budget.spent },
  };
};

export const inspectAuthorizedSnapshot = (
  snapshot: AuthorizedSnapshot,
): {
  readonly database: DatabaseId;
  readonly catalog: CatalogId;
  readonly catalogVersion: CatalogVersion;
  readonly policyHash: PolicyHash;
  readonly principal: AuthorizationPrincipal;
  readonly basisT: number;
  readonly asOfT: number | undefined;
  readonly history: boolean;
  readonly effectiveT: number;
  readonly ruleBasisT: number;
  readonly leaseEpoch: number;
  readonly cancelled: boolean;
  readonly expiresAt: number;
} => {
  const state = authorizedStates.get(snapshot);
  const lease = state === undefined ? deadLease(snapshot.leaseEpoch) : inspectLease(state.lease);
  return {
    database: state?.database ?? snapshot.database,
    catalog: state?.catalog ?? snapshot.catalog,
    catalogVersion: state?.catalogVersion ?? snapshot.catalogVersion,
    policyHash: state?.policyHash ?? snapshot.policyHash,
    principal: state?.principal ?? snapshot.principal,
    basisT: state?.bases.application.basisT ?? snapshot.basisT,
    asOfT: state?.bases.application.asOfT ?? snapshot.asOfT,
    history: state?.bases.application.history ?? snapshot.history,
    effectiveT: state?.bases.application.effectiveT ?? snapshot.effectiveT,
    ruleBasisT: state?.bases.ruleBasisT ?? snapshot.ruleBasisT,
    leaseEpoch: snapshot.leaseEpoch,
    cancelled: lease.cancelled,
    expiresAt: lease.expiresAt,
  };
};

export const invalidateRawSnapshot = (snapshot: RawSnapshot): void => {
  const state = rawStates.get(snapshot);
  if (state !== undefined) cancelLease(state.lease);
};

export const invalidateRuleSnapshot = (snapshot: RuleSnapshot): void => {
  const state = ruleStates.get(snapshot);
  if (state !== undefined) cancelLease(state.lease);
};

export const invalidateAuthorizedSnapshot = (snapshot: AuthorizedSnapshot): void => {
  const state = authorizedStates.get(snapshot);
  if (state !== undefined) cancelLease(state.lease);
};

const requireLiveLease = (
  lease: SnapshotLeaseState | undefined,
  now?: number,
): Result.Result<void, LeaseExpired | SnapshotCancelled> => {
  if (lease === undefined) return Result.fail(notLive());
  return checkLease(lease, now);
};

export const checkRawSnapshot = (
  snapshot: RawSnapshot,
  now?: number,
): Result.Result<void, LeaseExpired | SnapshotCancelled> =>
  requireLiveLease(rawStates.get(snapshot)?.lease, now);

export const checkRuleSnapshot = (
  snapshot: RuleSnapshot,
  now?: number,
): Result.Result<void, LeaseExpired | SnapshotCancelled> =>
  requireLiveLease(ruleStates.get(snapshot)?.lease, now);

export const checkAuthorizedSnapshot = (
  snapshot: AuthorizedSnapshot,
  now?: number,
): Result.Result<void, LeaseExpired | SnapshotCancelled> =>
  requireLiveLease(authorizedStates.get(snapshot)?.lease, now);

/** @internal Trusted storage / rule projection only. Dead or expired raw handles yield `undefined`. */
export const physicalCurrentDb = (snapshot: RawSnapshot, now?: number): Db | undefined =>
  liveRawState(snapshot, now)?.current;

/** @internal Trusted storage only. Application collapse of the raw handle. */
export const physicalViewDb = (snapshot: RawSnapshot, now?: number): Db | undefined =>
  liveRawState(snapshot, now)?.view;

export type RuleProjectionBudget = {
  readonly spent: number;
  readonly limit: number;
};

export type LiveRuleProjection = {
  readonly projected: Projected;
  readonly budget: RuleProjectionBudget;
};

const liveRuleState = (snapshot: RuleSnapshot, now?: number): RuleProjectionState | undefined => {
  const state = ruleStates.get(snapshot);
  if (state === undefined) return undefined;
  if (Result.isFailure(checkLease(state.lease, now))) return undefined;
  return state;
};

const ruleProjectionBudget = (state: RuleProjectionState): RuleProjectionBudget => ({
  spent: state.budget.spent,
  limit: state.budget.limit,
});

const runLiveRuleProjection = async (
  snapshot: RuleSnapshot,
  project: (state: RuleProjectionState) => Promise<Projected>,
): Promise<Result.Result<LiveRuleProjection, LeaseExpired | SnapshotCancelled>> => {
  const state = liveRuleState(snapshot);
  if (state === undefined) return Result.fail(notLive());
  const projected = await project(state);
  if (liveRuleState(snapshot) === undefined) return Result.fail(notLive());
  return Result.succeed({ projected, budget: ruleProjectionBudget(state) });
};

/** @internal Policy evaluator only. Lease-checked, bounded field lookup. */
export const projectLiveRuleField = (
  snapshot: RuleSnapshot,
  eid: number,
  field: FieldId,
): Promise<Result.Result<LiveRuleProjection, LeaseExpired | SnapshotCancelled>> =>
  runLiveRuleProjection(snapshot, (state) =>
    projectFieldFromDb(state.current, state.index, eid, field, state.budget),
  );

/** @internal Policy evaluator only. Lease-checked, bounded traversal. */
export const traverseLiveRuleFields = (
  snapshot: RuleSnapshot,
  eid: number,
  steps: readonly FieldId[],
): Promise<Result.Result<LiveRuleProjection, LeaseExpired | SnapshotCancelled>> =>
  runLiveRuleProjection(snapshot, (state) =>
    traverseFieldsFromDb(state.current, state.index, eid, steps, state.budget),
  );

/** @internal Policy evaluator only. Lease-checked, bounded me traversal. */
export const traverseLiveRuleFromMe = (
  snapshot: RuleSnapshot,
  steps: readonly FieldId[],
): Promise<Result.Result<LiveRuleProjection, LeaseExpired | SnapshotCancelled>> =>
  runLiveRuleProjection(snapshot, (state) =>
    traverseFromMeFromDb(state.current, state.index, state.principal, steps, state.budget),
  );

const requireAdmissionTicket = (
  ticket: AdmissionTicket,
  database: DatabaseId,
  now = Date.now(),
): Result.Result<AuthorizationPrincipal, AuthenticationRejected | LeaseExpired | CatalogMismatch> => {
  if (!isVerifiedAdmissionTicket(ticket)) {
    return Result.fail(new AuthenticationRejected({ message: "admission ticket is not sealed" }));
  }
  if (ticket.principal.subject.length === 0) {
    return Result.fail(new AuthenticationRejected({ message: "verified principal is required" }));
  }
  if (ticket.database !== database) {
    return Result.fail(
      new CatalogMismatch({
        message: "admission ticket database does not match installed policy",
        expectedDatabase: database,
        actualDatabase: ticket.database,
      }),
    );
  }
  if (now >= ticket.expiresAt) {
    return Result.fail(new LeaseExpired({ message: "admission ticket expired" }));
  }
  return Result.succeed(ticket.principal);
};

const requireMatchingLeaseEpoch = (
  ticket: AdmissionTicket,
  leaseEpoch: number | undefined,
): Result.Result<number, AuthenticationRejected> => {
  if (leaseEpoch !== undefined && leaseEpoch !== ticket.leaseEpoch) {
    return Result.fail(
      new AuthenticationRejected({ message: "admission ticket lease epoch does not match" }),
    );
  }
  return Result.succeed(ticket.leaseEpoch);
};

const ticketExpiresAt = (ticket: AdmissionTicket, expiresAt: number | undefined): number =>
  Math.min(expiresAt ?? ticket.expiresAt, ticket.expiresAt);

const collapsedView = (current: Db, application: ReturnType<typeof collapseApplicationBasis>): Db => {
  let view = current.asOf(application.effectiveT);
  if (application.history) view = view.history();
  return view;
};

const createRawSnapshot = (input: {
  readonly database: DatabaseId;
  readonly current: Db;
  readonly basisT: number;
  readonly asOfT?: number | undefined;
  readonly history?: boolean | undefined;
  readonly leaseEpoch: number;
  readonly expiresAt?: number | undefined;
  readonly now?: number | undefined;
}): RawSnapshot => {
  const application = collapseApplicationBasis({
    basisT: input.basisT,
    ...(input.asOfT === undefined ? {} : { asOfT: input.asOfT }),
    ...(input.history === undefined ? {} : { history: input.history }),
  });
  return constructRaw(
    Object.freeze({
      database: input.database,
      current: input.current,
      view: collapsedView(input.current, application),
      application,
      lease: createLeaseState({
        epoch: input.leaseEpoch,
        ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
        ...(input.now === undefined ? {} : { now: input.now }),
      }),
    }),
  );
};

const createRuleSnapshot = (input: {
  readonly database: DatabaseId;
  readonly catalog: CatalogDescriptor;
  readonly installed: InstalledAuthorizationIRV1;
  readonly principal: AuthorizationPrincipal;
  readonly current: Db;
  readonly basisT: number;
  readonly leaseEpoch: number;
  readonly budgetLimit: number;
  readonly expiresAt?: number | undefined;
  readonly now?: number | undefined;
}): RuleSnapshot => {
  const fields = new Map<string, FieldDescriptor>();
  for (const field of input.catalog.fields) fields.set(fieldDescriptorKey(field.id), field);
  return constructRule(
    Object.freeze({
      database: input.database,
      catalog: input.catalog.id,
      catalogVersion: input.catalog.version,
      policyHash: input.installed.policyHash,
      basisT: input.basisT,
      principal: freezePrincipal(input.principal),
      installed: input.installed,
      index: Object.freeze({
        fields,
        storageIdents: fieldStorageIndex(input.catalog.fields),
        compositions: traversalCompositionsOf(input.catalog),
      }),
      current: input.current,
      budget: { limit: input.budgetLimit, spent: 0 },
      lease: createLeaseState({
        epoch: input.leaseEpoch,
        ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
        ...(input.now === undefined ? {} : { now: input.now }),
      }),
    }),
  );
};

const createAuthorizedSnapshot = (input: {
  readonly database: DatabaseId;
  readonly catalog: CatalogId;
  readonly catalogVersion: CatalogVersion;
  readonly installed: InstalledAuthorizationIRV1;
  readonly principal: AuthorizationPrincipal;
  readonly applicationBasisT: number;
  readonly ruleBasisT: number;
  readonly asOfT?: number | undefined;
  readonly history?: boolean | undefined;
  readonly leaseEpoch: number;
  readonly expiresAt?: number | undefined;
  readonly now?: number | undefined;
}): AuthorizedSnapshot =>
  constructAuthorized(
    Object.freeze({
      database: input.database,
      catalog: input.catalog,
      catalogVersion: input.catalogVersion,
      policyHash: input.installed.policyHash,
      principal: freezePrincipal(input.principal),
      installed: input.installed,
      bases: mergeSnapshotBases(
        collapseApplicationBasis({
          basisT: input.applicationBasisT,
          ...(input.asOfT === undefined ? {} : { asOfT: input.asOfT }),
          ...(input.history === undefined ? {} : { history: input.history }),
        }),
        input.ruleBasisT,
      ),
      lease: createLeaseState({
        epoch: input.leaseEpoch,
        ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
        ...(input.now === undefined ? {} : { now: input.now }),
      }),
    }),
  );

export const mintRawSnapshot = (input: {
  readonly database: DatabaseId;
  readonly current: Db;
  readonly basisT: number;
  readonly asOfT?: number | undefined;
  readonly history?: boolean | undefined;
  readonly leaseEpoch: number;
  readonly expiresAt?: number | undefined;
  readonly now?: number | undefined;
}): Result.Result<RawSnapshot, RawStorageFailure> => {
  if (input.basisT > input.current.basisT) {
    return Result.fail(new RawStorageUnavailable({ message: "requested basis is ahead of storage" }));
  }
  return Result.succeed(createRawSnapshot(input));
};

export const mintRuleSnapshot = (input: {
  readonly raw: RawSnapshot;
  readonly installed: InstalledAuthorizationIRV1;
  readonly catalog: CatalogDescriptor;
  readonly ticket: AdmissionTicket;
  readonly basisT: number;
  readonly leaseEpoch?: number | undefined;
  readonly budgetLimit?: number | undefined;
  readonly expiresAt?: number | undefined;
}): Result.Result<RuleSnapshot, RuleSnapshotFailure> =>
  Result.gen(function* () {
    if (!isVerifiedInstalledAuthorization(input.installed)) {
      return yield* Result.fail(new InvalidIR({ message: "compiled policy is not sealed installed IR" }));
    }
    const principal = yield* requireAdmissionTicket(input.ticket, input.installed.database);
    const leaseEpoch = yield* requireMatchingLeaseEpoch(input.ticket, input.leaseEpoch);
    if (
      input.catalog.id !== input.installed.catalog ||
      input.catalog.version !== input.installed.catalogVersion ||
      input.catalog.database !== input.installed.database ||
      input.catalog.fingerprint !== input.installed.schemaFingerprint
    ) {
      return yield* Result.fail(
        new CatalogMismatch({
          message: "catalog identity does not match installed policy",
          expected: input.installed.catalog,
          actual: input.catalog.id,
          expectedVersion: input.installed.catalogVersion,
          actualVersion: input.catalog.version,
          expectedFingerprint: input.installed.schemaFingerprint,
          actualFingerprint: input.catalog.fingerprint,
          expectedDatabase: input.installed.database,
          actualDatabase: input.catalog.database,
        }),
      );
    }
    yield* checkRawSnapshot(input.raw);
    const rawState = liveRawState(input.raw);
    if (rawState === undefined) return yield* Result.fail(notLive());
    if (rawState.database !== input.installed.database) {
      return yield* Result.fail(
        new CatalogMismatch({
          message: "raw snapshot database does not match installed policy",
          expectedDatabase: input.installed.database,
          actualDatabase: rawState.database,
        }),
      );
    }
    if (input.basisT !== rawState.current.basisT) {
      return yield* Result.fail(
        new RuleSnapshotUnavailable({ message: "rule basis must equal the current storage basis" }),
      );
    }
    return createRuleSnapshot({
      database: input.installed.database,
      catalog: input.catalog,
      installed: input.installed,
      principal,
      current: rawState.current,
      basisT: input.basisT,
      leaseEpoch,
      budgetLimit: input.budgetLimit ?? DEFAULT_AUTHORIZATION_BUDGET,
      expiresAt: ticketExpiresAt(input.ticket, input.expiresAt),
    });
  });

export const mintAuthorizedSnapshot = (input: {
  readonly raw: RawSnapshot;
  readonly ticket: AdmissionTicket;
  readonly installed: InstalledAuthorizationIRV1;
  readonly catalog: CatalogId;
  readonly catalogVersion: CatalogVersion;
  readonly database: DatabaseId;
  readonly applicationBasisT: number;
  readonly ruleBasisT: number;
  readonly leaseEpoch?: number | undefined;
  readonly asOfT?: number | undefined;
  readonly history?: boolean | undefined;
  readonly expiresAt?: number | undefined;
}): Result.Result<AuthorizedSnapshot, ApplicationSnapshotFailure> =>
  Result.gen(function* () {
    if (!isVerifiedInstalledAuthorization(input.installed)) {
      return yield* Result.fail(new InvalidIR({ message: "compiled policy is not sealed installed IR" }));
    }
    const principal = yield* requireAdmissionTicket(input.ticket, input.installed.database);
    const leaseEpoch = yield* requireMatchingLeaseEpoch(input.ticket, input.leaseEpoch);
    if (input.catalog === undefined || input.catalogVersion === undefined) {
      return yield* Result.fail(new ApplicationSnapshotUnavailable({ message: "catalog identity is required" }));
    }
    if (
      input.catalog !== input.installed.catalog ||
      input.catalogVersion !== input.installed.catalogVersion ||
      input.database !== input.installed.database
    ) {
      return yield* Result.fail(
        new CatalogMismatch({
          message: "catalog identity does not match installed policy",
          expected: input.installed.catalog,
          actual: input.catalog,
          expectedVersion: input.installed.catalogVersion,
          actualVersion: input.catalogVersion,
          expectedDatabase: input.installed.database,
          actualDatabase: input.database,
        }),
      );
    }
    yield* checkRawSnapshot(input.raw);
    const rawState = liveRawState(input.raw);
    if (rawState === undefined) {
      return yield* Result.fail(
        new ApplicationSnapshotUnavailable({ message: "raw snapshot is not a live capability" }),
      );
    }
    if (rawState.database !== input.installed.database) {
      return yield* Result.fail(
        new CatalogMismatch({
          message: "raw snapshot database does not match installed policy",
          expectedDatabase: input.installed.database,
          actualDatabase: rawState.database,
        }),
      );
    }
    if (input.applicationBasisT > rawState.current.basisT) {
      return yield* Result.fail(new ApplicationSnapshotUnavailable({ message: "basis is ahead of storage" }));
    }
    if (input.ruleBasisT !== rawState.current.basisT) {
      return yield* Result.fail(
        new ApplicationSnapshotUnavailable({ message: "rule basis must equal the current storage basis" }),
      );
    }
    if (
      input.applicationBasisT !== rawState.application.basisT ||
      (input.asOfT === undefined ? undefined : input.asOfT) !== rawState.application.asOfT ||
      (input.history === true) !== rawState.application.history
    ) {
      return yield* Result.fail(
        new ApplicationSnapshotUnavailable({ message: "application basis does not match raw snapshot" }),
      );
    }
    return createAuthorizedSnapshot({
      database: input.database,
      catalog: input.catalog,
      catalogVersion: input.catalogVersion,
      installed: input.installed,
      principal,
      applicationBasisT: input.applicationBasisT,
      ruleBasisT: input.ruleBasisT,
      leaseEpoch,
      expiresAt: ticketExpiresAt(input.ticket, input.expiresAt),
      ...(input.asOfT === undefined ? {} : { asOfT: input.asOfT }),
      ...(input.history === undefined ? {} : { history: input.history }),
    });
  });

export { fieldDescriptorKey, fieldStorageIndex, physicalStorageIdent, traversalCompositionsOf };
