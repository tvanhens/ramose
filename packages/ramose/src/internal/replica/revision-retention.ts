export const MAX_REPLICATION_REVISIONS_PER_BINDING = 8;

export type ReplicationProgression = {
  readonly revision: string;
  readonly basisT: number;
  readonly ordinal: number;
};

export type ReplicationOrdinalIssuance =
  | { readonly type: "issued"; readonly progression: ReplicationProgression }
  | { readonly type: "refused" };

export const isReplicationProgression = (
  value: unknown,
): value is ReplicationProgression => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<ReplicationProgression>;
  return typeof record.revision === "string" &&
    Number.isSafeInteger(record.basisT) && (record.basisT as number) >= 0 &&
    Number.isSafeInteger(record.ordinal) && (record.ordinal as number) > 0;
};

export const issueReplicationOrdinal = (
  stored: ReplicationProgression | undefined,
  candidate: { readonly revision: string; readonly basisT: number },
): ReplicationOrdinalIssuance => {
  if (stored === undefined) {
    return {
      type: "issued",
      progression: { ...candidate, ordinal: 1 },
    };
  }
  if (stored.revision === candidate.revision) {
    return {
      type: "issued",
      progression: {
        revision: stored.revision,
        basisT: Math.max(stored.basisT, candidate.basisT),
        ordinal: stored.ordinal,
      },
    };
  }
  if (candidate.basisT < stored.basisT) return { type: "refused" };
  return {
    type: "issued",
    progression: { ...candidate, ordinal: stored.ordinal + 1 },
  };
};

export type ReplicationRevisionRetentionDecision =
  | { readonly type: "advance" }
  | { readonly type: "insert"; readonly evictCount: number }
  | { readonly type: "reject" };

export const decideReplicationRevisionRetention = (input: {
  readonly existingBinding?: string;
  readonly candidateBinding: string;
  readonly bindingRevisionCount: number;
}): ReplicationRevisionRetentionDecision => {
  if (input.existingBinding !== undefined) {
    return input.existingBinding === input.candidateBinding
      ? { type: "advance" }
      : { type: "reject" };
  }
  return {
    type: "insert",
    evictCount: Math.max(
      0,
      input.bindingRevisionCount + 1 -
        MAX_REPLICATION_REVISIONS_PER_BINDING,
    ),
  };
};
