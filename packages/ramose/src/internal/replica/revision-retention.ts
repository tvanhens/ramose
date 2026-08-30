export const MAX_REPLICATION_REVISIONS_PER_BINDING = 8;

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
