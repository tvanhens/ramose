import { describe, expect, test } from "bun:test";
import {
  MAX_REPLICATION_REVISIONS_PER_BINDING,
  retainReplicationRevision,
  type ReplicationRevisionRetentionRecord,
} from "../../../src/internal/replica/revision-retention.ts";

const add = (
  records: readonly ReplicationRevisionRetentionRecord[],
  binding: string,
  revision: string,
  basisT: number,
  touched: number,
) => retainReplicationRevision(
  records,
  { binding, revision, basisT },
  touched,
);

describe("opaque revision retention", () => {
  test("a hidden-only basis advance cannot refresh the revision's eviction order", () => {
    let records: readonly ReplicationRevisionRetentionRecord[] = [];
    for (let index = 0; index < MAX_REPLICATION_REVISIONS_PER_BINDING; index++) {
      records = add(records, "view-a", `a-${index}`, index, index + 1).records;
    }

    const zeroWorld = add(records, "view-a", "a-visible-next", 20, 100);
    const hiddenAdvance = add(records, "view-a", "a-0", 19, 10_000);
    expect(hiddenAdvance.stored).toBe(true);
    expect(hiddenAdvance.records.find((record) => record.revision === "a-0"))
      .toEqual({ revision: "a-0", binding: "view-a", basisT: 19, touched: 1 });
    const hiddenWorld = add(
      hiddenAdvance.records,
      "view-a",
      "a-visible-next",
      20,
      100,
    );

    expect(zeroWorld.records.some((record) => record.revision === "a-0"))
      .toBe(false);
    expect(hiddenWorld.records.some((record) => record.revision === "a-0"))
      .toBe(false);
    expect(hiddenWorld.records.map((record) => record.revision).sort())
      .toEqual(zeroWorld.records.map((record) => record.revision).sort());
  });

  test("a first-seen view has the same quota after pressure in another binding", () => {
    const zeroWorld = new Map<string, readonly ReplicationRevisionRetentionRecord[]>();
    const hiddenWorld = new Map<string, readonly ReplicationRevisionRetentionRecord[]>();
    let touched = 0;

    // Each map entry represents the independently addressed Durable Object for
    // that opaque binding. Fill and churn many B partitions before A exists.
    for (let binding = 0; binding < 80; binding++) {
      let records: readonly ReplicationRevisionRetentionRecord[] = [];
      for (let revision = 0; revision < 20; revision++) {
        records = add(
          records,
          `view-b-${binding}`,
          `b-${binding}-${revision}`,
          revision,
          ++touched,
        ).records;
      }
      expect(records).toHaveLength(MAX_REPLICATION_REVISIONS_PER_BINDING);
      hiddenWorld.set(`view-b-${binding}`, records);
    }

    const a = {
      binding: "view-a",
      revision: "identical-a-revision",
      basisT: 41,
    } as const;
    const aTouched = ++touched;
    const zeroA = add(zeroWorld.get(a.binding) ?? [], a.binding, a.revision, a.basisT, aTouched);
    const hiddenA = add(hiddenWorld.get(a.binding) ?? [], a.binding, a.revision, a.basisT, aTouched);
    zeroWorld.set(a.binding, zeroA.records);
    hiddenWorld.set(a.binding, hiddenA.records);

    expect(zeroA.stored).toBe(true);
    expect(hiddenA.stored).toBe(true);
    expect(hiddenWorld.get(a.binding)).toEqual(zeroWorld.get(a.binding));
    expect(hiddenWorld.get(a.binding)?.find((record) =>
      record.revision === a.revision
    )?.basisT).toBe(41);
  });
});
