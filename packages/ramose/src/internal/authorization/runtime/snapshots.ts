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
 * @internal
 */

import type { Db } from "../../core/db.ts";
import { LeaseExpired } from "../failures.ts";
import type { CatalogDescriptor, FieldDescriptor } from "../catalog.ts";
import type { CatalogId, CatalogVersion, DatabaseId, PolicyHash } from "../identities.ts";
import type { InstalledAuthorizationIRV1 } from "../ir.ts";
import type { AuthorizationPrincipal } from "../principal.ts";
import {
  collapseApplicationBasis,
  mergeSnapshotBases,
  type SnapshotBases,
} from "./basis.ts";
import { SnapshotCancelled } from "./failures.ts";
import {
  cancelLease,
  checkLease,
  createLeaseState,
  inspectLease,
  type SnapshotLeaseState,
} from "./lease.ts";
import * as Result from "effect/Result";

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

export type RuleProjectionState = {
  readonly database: DatabaseId;
  readonly catalog: CatalogId;
  readonly catalogVersion: CatalogVersion;
  readonly policyHash: PolicyHash;
  readonly basisT: number;
  readonly principal: AuthorizationPrincipal;
  readonly installed: InstalledAuthorizationIRV1;
  readonly fields: ReadonlyMap<string, FieldDescriptor>;
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
  }

  static {
    constructAuthorized = (state) => new AuthorizedSnapshot(state);
  }
}

const deadLease = (epoch: number) => ({ epoch, expiresAt: 0, cancelled: true as const });

const notLive = (): SnapshotCancelled =>
  new SnapshotCancelled({ message: "snapshot is not a live capability" });

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
  return {
    database: snapshot.database,
    basisT: snapshot.basisT,
    asOfT: snapshot.asOfT,
    history: snapshot.history,
    effectiveT: snapshot.effectiveT,
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
    database: snapshot.database,
    catalog: snapshot.catalog,
    catalogVersion: snapshot.catalogVersion,
    policyHash: snapshot.policyHash,
    basisT: snapshot.basisT,
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
    database: snapshot.database,
    catalog: snapshot.catalog,
    catalogVersion: snapshot.catalogVersion,
    policyHash: snapshot.policyHash,
    principal: snapshot.principal,
    basisT: snapshot.basisT,
    asOfT: snapshot.asOfT,
    history: snapshot.history,
    effectiveT: snapshot.effectiveT,
    ruleBasisT: snapshot.ruleBasisT,
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

/** @internal Trusted storage / rule projection only. */
export const physicalCurrentDb = (snapshot: RawSnapshot): Db | undefined =>
  rawStates.get(snapshot)?.current;

/** @internal Trusted storage only. Application collapse of the raw handle. */
export const physicalViewDb = (snapshot: RawSnapshot): Db | undefined =>
  rawStates.get(snapshot)?.view;

/** @internal Policy evaluator only. */
export const ruleProjectionState = (snapshot: RuleSnapshot): RuleProjectionState | undefined =>
  ruleStates.get(snapshot);

export const createRawSnapshot = (input: {
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
  let view = input.current;
  if (application.asOfT !== undefined) view = view.asOf(application.asOfT);
  if (application.history) view = view.history();
  return constructRaw({
    database: input.database,
    current: input.current,
    view,
    application,
    lease: createLeaseState({
      epoch: input.leaseEpoch,
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      ...(input.now === undefined ? {} : { now: input.now }),
    }),
  });
};

export const createRuleSnapshot = (input: {
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
  return constructRule({
    database: input.database,
    catalog: input.catalog.id,
    catalogVersion: input.catalog.version,
    policyHash: input.installed.policyHash,
    basisT: input.basisT,
    principal: input.principal,
    installed: input.installed,
    fields,
    current: input.current,
    budget: { limit: input.budgetLimit, spent: 0 },
    lease: createLeaseState({
      epoch: input.leaseEpoch,
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      ...(input.now === undefined ? {} : { now: input.now }),
    }),
  });
};

export const createAuthorizedSnapshot = (input: {
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
  constructAuthorized({
    database: input.database,
    catalog: input.catalog,
    catalogVersion: input.catalogVersion,
    policyHash: input.installed.policyHash,
    principal: input.principal,
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
  });

export const fieldDescriptorKey = (id: {
  readonly catalog: CatalogId;
  readonly owner: { readonly kind: string; readonly name: string };
  readonly localName: string;
}): string => `${id.catalog}\0${id.owner.kind}\0${id.owner.name}\0${id.localName}`;

export const fieldIdentOf = (id: {
  readonly owner: { readonly name: string };
  readonly localName: string;
}): string => `:${id.owner.name}/${id.localName}`;
