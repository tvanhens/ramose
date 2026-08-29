/** Pure Analytics Engine column mapping and failure-isolation decisions. */

import { describe, expect, test } from "bun:test";
import {
  TxMetrics,
  type AnalyticsEngineDatasetLike,
} from "../../../src/internal/transactor/index.ts";

type DataPoint = Parameters<AnalyticsEngineDatasetLike["writeDataPoint"]>[0];

const recordingMetrics = (): {
  readonly metrics: TxMetrics;
  readonly points: DataPoint[];
} => {
  const points: DataPoint[] = [];
  return {
    points,
    metrics: new TxMetrics({
      writeDataPoint(point): void {
        points.push(point);
      },
    }),
  };
};

describe("transactor observability decisions", () => {
  test("no dataset is a disabled no-op", () => {
    const metrics = new TxMetrics();
    metrics.batch({
      db: "d",
      resolveMs: 1,
      commitMs: 2,
      batchSize: 3,
      queueDepth: 4,
      noveltyDatoms: 5,
      txOk: 3,
      txErr: 0,
    });
    expect(metrics.snapshot()).toEqual({
      enabled: false,
      colo: "unknown",
      aeWrites: 0,
      aeErrors: 0,
    });
  });

  test("batch and index points use the documented columns", () => {
    const { metrics, points } = recordingMetrics();
    metrics.observeColo(undefined);
    metrics.observeColo("LHR");
    metrics.batch({
      db: "d",
      resolveMs: 1,
      commitMs: 2,
      batchSize: 3,
      queueDepth: 4,
      noveltyDatoms: 5,
      txOk: 2,
      txErr: 1,
      fenceMs: 6,
    });
    metrics.index({
      db: "d",
      indexMs: 9,
      txs: 8,
      datoms: 7,
      noveltyDatoms: 6,
    });

    expect(points).toEqual([
      {
        indexes: ["d"],
        blobs: ["batch", "d", "LHR"],
        doubles: [1, 2, 3, 4, 5, 2, 1, 6],
      },
      {
        indexes: ["d"],
        blobs: ["index", "d", "LHR"],
        doubles: [9, 0, 8, 0, 6, 7, 0],
      },
    ]);
    expect(metrics.snapshot()).toEqual({
      enabled: true,
      colo: "LHR",
      aeWrites: 2,
      aeErrors: 0,
    });
  });

  test("a throwing sink is counted and never escapes", () => {
    const metrics = new TxMetrics({
      writeDataPoint(): void {
        throw new Error("analytics unavailable");
      },
    });

    expect(() =>
      metrics.batch({
        db: "d",
        resolveMs: 1,
        commitMs: 2,
        batchSize: 1,
        queueDepth: 1,
        noveltyDatoms: 1,
        txOk: 1,
        txErr: 0,
      })
    ).not.toThrow();
    expect(metrics.snapshot()).toEqual({
      enabled: true,
      colo: "unknown",
      aeWrites: 0,
      aeErrors: 1,
    });
  });
});
