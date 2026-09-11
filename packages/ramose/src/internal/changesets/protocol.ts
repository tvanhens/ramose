import { CatalogId, CatalogUnitHash, DatabaseId } from "../authorization/identities.ts";
import { AuthenticatedCallerSchema } from "../authorization/invocation-codec.ts";
import * as S from "effect/Schema";

const Id = S.String.pipe(S.check(S.isPattern(/^[a-zA-Z0-9_-]{1,128}$/)));
const Revision = S.String.pipe(S.check(S.isMinLength(1)));
const operations = S.Array(S.Record(S.String, S.Unknown)).pipe(S.check(S.isMinLength(1), S.isMaxLength(100)));
const title = S.String.pipe(S.check(S.isMaxLength(200)));

export const ChangesetRequest = S.Union([
  S.Struct({ action: S.Literal("list"), after: S.optionalKey(Id), limit: S.optionalKey(S.Int.pipe(S.check(S.isBetween({ minimum: 1, maximum: 100 })))) }),
  S.Struct({ action: S.Literal("watch"), version: S.optionalKey(S.String), id: S.optionalKey(Id), after: S.optionalKey(Id), limit: S.optionalKey(S.Int.pipe(S.check(S.isBetween({ minimum: 1, maximum: 100 })))) }),
  S.Struct({ action: S.Literal("prepare"), id: Id, revision: S.optionalKey(Revision), title, reviewers: S.optionalKey(S.Array(S.String).pipe(S.check(S.isMaxLength(32)))), operations }),
  S.Struct({ action: S.Literal("append"), id: Id, revision: Revision, operations }),
  S.Struct({ action: S.Literal("inspect"), id: Id }),
  S.Struct({ action: S.Literal("commit"), id: Id, revision: Revision }),
  S.Struct({ action: S.Literal("discard"), id: Id, revision: Revision }),
  S.Struct({ action: S.Literal("query"), id: S.optionalKey(Id), revision: S.optionalKey(Revision), query: S.Unknown }),
  S.Struct({ action: S.Literal("read"), id: Id, revision: Revision, query: S.Record(S.String, S.Unknown) }),
]);
export type ChangesetRequest = typeof ChangesetRequest.Type;
export const decodeChangesetRequest = S.decodeUnknownSync(ChangesetRequest);

export const ChangesetFact = S.Struct({ entity: S.String, field: S.String, value: S.Unknown, added: S.Boolean });
export const ChangesetResponse = S.Struct({
  id: Id, revision: Revision, title, status: S.Literals(["draft", "committed", "discarded", "expired"]),
  basis: S.Int, stale: S.Boolean, expiresAt: S.Finite, operations: S.Int,
  changes: S.optionalKey(S.Array(ChangesetFact)),
});
export type ChangesetResponse = typeof ChangesetResponse.Type;
export const decodeChangesetResponse = S.decodeUnknownSync(ChangesetResponse);
export const decodeQueryResponse = S.decodeUnknownSync(S.Struct({
  rows: S.Array(S.Struct({ entity: S.String, data: S.Record(S.String, S.Unknown) })), truncated: S.Boolean,
}));
export const decodeReadResponse = S.decodeUnknownSync(S.Struct({
  result: S.Unknown, entities: S.Array(S.String), basis: S.Int, revision: Revision,
}));

export const decodeCommandEnvelope = S.decodeUnknownSync(S.Struct({
  catalogKey: CatalogId, unitHash: CatalogUnitHash, database: DatabaseId,
  caller: AuthenticatedCallerSchema, maxCells: S.optionalKey(S.Int.pipe(S.check(S.isGreaterThan(0)))),
  approval: S.optionalKey(S.Boolean),
}));

export const decodeChangesetList = S.decodeUnknownSync(S.Struct({ items: S.Array(ChangesetResponse), nextCursor: S.NullOr(Id), version: S.String }));
