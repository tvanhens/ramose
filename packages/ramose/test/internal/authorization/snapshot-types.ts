/**
 * Type-level proofs that raw, rule, and authorized snapshots are not
 * interchangeable (TCB-1, TCB-3). `bun run typecheck` compiles this file.
 */

import { expect, test } from "bun:test";
import type { Equal, Expect, Extends } from "../../../src/db/equal.ts";
import type { Db } from "../../../src/internal/core/db.ts";
import { query } from "../../../src/internal/core/query/engine.ts";
import { pull } from "../../../src/internal/core/query/pull.ts";
import type { AdmissionTicket } from "../../../src/internal/authorization/runtime/authentication.ts";
import type { AuthorizedSnapshotRequest } from "../../../src/internal/authorization/runtime/application-snapshot.ts";
import {
  pullAuthorized,
  queryAuthorized,
  type RejectRawPull,
  type RejectRawQuery,
  type RejectRulePull,
  type RejectRuleQuery,
} from "../../../src/internal/authorization/runtime/application-read.ts";
import type { InstalledAuthorizationIR, InstalledAuthorizationIRV1 } from "../../../src/internal/authorization/ir.ts";
import {
  AuthorizedSnapshot,
  RawSnapshot,
  RuleSnapshot,
} from "../../../src/internal/authorization/runtime/snapshots.ts";

export type _rawNotRule = Expect<Equal<Extends<RawSnapshot, RuleSnapshot>, false>>;
export type _ruleNotRaw = Expect<Equal<Extends<RuleSnapshot, RawSnapshot>, false>>;
export type _authNotRaw = Expect<Equal<Extends<AuthorizedSnapshot, RawSnapshot>, false>>;
export type _rawNotAuth = Expect<Equal<Extends<RawSnapshot, AuthorizedSnapshot>, false>>;
export type _authNotRule = Expect<Equal<Extends<AuthorizedSnapshot, RuleSnapshot>, false>>;
export type _ruleNotAuth = Expect<Equal<Extends<RuleSnapshot, AuthorizedSnapshot>, false>>;
export type _rawNotDb = Expect<Equal<Extends<RawSnapshot, Db>, false>>;
export type _ruleNotDb = Expect<Equal<Extends<RuleSnapshot, Db>, false>>;
export type _authNotDb = Expect<Equal<Extends<AuthorizedSnapshot, Db>, false>>;
export type _dbNotAuth = Expect<Equal<Extends<Db, AuthorizedSnapshot>, false>>;

export type _queryArg = Expect<Equal<Parameters<typeof queryAuthorized>[0], AuthorizedSnapshot>>;
export type _pullArg = Expect<Equal<Parameters<typeof pullAuthorized>[0], AuthorizedSnapshot>>;
export type _queryRejectsRaw = Expect<RejectRawQuery>;
export type _queryRejectsRule = Expect<RejectRuleQuery>;
export type _pullRejectsRaw = Expect<RejectRawPull>;
export type _pullRejectsRule = Expect<RejectRulePull>;

export type _openRequiresTicket = Expect<Extends<"ticket", keyof AuthorizedSnapshotRequest>>;
export type _openRequiresInstalled = Expect<Extends<"installed", keyof AuthorizedSnapshotRequest>>;
export type _openRequiresCatalog = Expect<Extends<"catalog", keyof AuthorizedSnapshotRequest>>;
export type _openRequiresCatalogVersion = Expect<
  Extends<"catalogVersion", keyof AuthorizedSnapshotRequest>
>;
export type _openRequiresRuleBasis = Expect<Extends<"ruleBasisT", keyof AuthorizedSnapshotRequest>>;
export type _openRequiresAppBasis = Expect<
  Extends<"applicationBasisT", keyof AuthorizedSnapshotRequest>
>;
export type _openRequiresRaw = Expect<Extends<"raw", keyof AuthorizedSnapshotRequest>>;
export type _installedNotVerified = Expect<
  Equal<Extends<InstalledAuthorizationIR, InstalledAuthorizationIRV1>, false>
>;

declare const raw: RawSnapshot;
declare const rule: RuleSnapshot;
declare const auth: AuthorizedSnapshot;
declare const db: Db;

// @ts-expect-error — raw is not an authorized snapshot
const _qRaw = queryAuthorized(raw, {});
// @ts-expect-error — rule is not an authorized snapshot
const _qRule = queryAuthorized(rule, {});
// @ts-expect-error — physical Db is not an authorized snapshot
const _qDb = queryAuthorized(db, {});
// @ts-expect-error — raw is not an authorized snapshot
const _pRaw = pullAuthorized(raw, 1, ["*"]);
// @ts-expect-error — rule is not an authorized snapshot
const _pRule = pullAuthorized(rule, 1, ["*"]);
// @ts-expect-error — authorized snapshot is not a physical Db
query(auth, { find: ["?e"], where: [] });
// @ts-expect-error — authorized snapshot is not a physical Db
pull(auth, 1, ["*"]);
// @ts-expect-error — constructor is private
new RawSnapshot();
// @ts-expect-error — constructor is private
new RuleSnapshot();
// @ts-expect-error — constructor is private
new AuthorizedSnapshot();

const _missingTicket: AuthorizedSnapshotRequest = {
  raw,
  // @ts-expect-error — sealed admission ticket is required
  ticket: undefined,
  installed: {} as InstalledAuthorizationIRV1,
  catalog: "app" as AuthorizedSnapshotRequest["catalog"],
  catalogVersion: "1" as AuthorizedSnapshotRequest["catalogVersion"],
  database: "todos" as AuthorizedSnapshotRequest["database"],
  applicationBasisT: 1,
  ruleBasisT: 1,
};

void _missingTicket;
declare const _ticket: AdmissionTicket;
void _ticket;
void queryAuthorized;
void pullAuthorized;
void query;
void pull;
void raw;
void rule;
void auth;
void db;
void _qRaw;
void _qRule;
void _qDb;
void _pRaw;
void _pRule;

test("snapshot type fixtures compile", () => {
  expect(true).toBe(true);
});
