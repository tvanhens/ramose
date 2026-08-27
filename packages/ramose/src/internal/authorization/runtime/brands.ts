/**
 * Snapshot capability types. Real values live in {@link ./snapshots.ts}.
 *
 * Distinct types, never subtypes of one another or of physical `Db`.
 * Inheritance, casts, public constructors, and generic `Db` passing must
 * not recover a more privileged capability (TCB-1).
 *
 * @internal
 */

export {
  AuthorizedSnapshot,
  RawSnapshot,
  RuleSnapshot,
} from "./snapshots.ts";
