/** Pure bounded retention policy for one binding-addressed revision store. */

export const MAX_REPLICATION_REVISIONS_PER_BINDING = 8;

export type ReplicationRevisionRetentionRecord = {
  readonly revision: string;
  readonly binding: string;
  readonly basisT: number;
  readonly touched: number;
};

export type ReplicationRevisionRetentionDecision =
  | { readonly type: "advance" }
  | { readonly type: "insert"; readonly evictCount: number }
  | { readonly type: "reject" };

/**
 * The caller routes each authenticated binding to its own Durable Object, so
 * this transition sees only that partition's fixed quota. The binding check
 * rejects a cryptographic revision collision instead of crossing partitions.
 */
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

/** Reference transition used by pure cap/noninterference tests. */
export const retainReplicationRevision = (
  records: readonly ReplicationRevisionRetentionRecord[],
  candidate: Omit<ReplicationRevisionRetentionRecord, "touched">,
  touched: number,
): {
  readonly stored: boolean;
  readonly records: readonly ReplicationRevisionRetentionRecord[];
} => {
  const existing = records.find((record) =>
    record.revision === candidate.revision
  );
  const bindingRecords = records.filter((record) =>
    record.binding === candidate.binding
  );
  const decision = decideReplicationRevisionRetention({
    ...(existing === undefined ? {} : { existingBinding: existing.binding }),
    candidateBinding: candidate.binding,
    bindingRevisionCount: bindingRecords.length,
  });
  if (decision.type === "reject") {
    return { stored: false, records };
  }
  if (decision.type === "advance") {
    return {
      stored: true,
      records: Object.freeze(records.map((record) =>
        record.revision === candidate.revision
          ? Object.freeze({
            ...record,
            basisT: Math.max(record.basisT, candidate.basisT),
          })
          : record
      )),
    };
  }
  const evicted = new Set(
    [...bindingRecords]
      .sort((left, right) =>
        left.touched - right.touched ||
        left.revision.localeCompare(right.revision)
      )
      .slice(0, decision.evictCount)
      .map((record) => record.revision),
  );
  return {
    stored: true,
    records: Object.freeze([
      ...records.filter((record) => !evicted.has(record.revision)),
      Object.freeze({ ...candidate, touched }),
    ]),
  };
};
