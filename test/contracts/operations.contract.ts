/**
 * Public `/op` and `/health` operations listing against a real peer.
 *
 * `/db/:name/op` is fail-closed with the rest of the data plane.
 */

import { describe, expect, test } from "bun:test";
import { json, post, uniqueDb, type LocalUrls } from "../local/fixtures.ts";
import { OPERATION_IDS } from "../local/ops.ts";

export interface OperationsTarget {
  readonly urls: () => LocalUrls;
}

export function registerOperationsContract(target: OperationsTarget): void {
  describe("GET /health lists registered operation ids", () => {
    test("the peer reports the registry it was built with", async () => {
      const { openUrl } = target.urls();
      const { status, body } = await json(openUrl, "/health");
      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.operations).toEqual(OPERATION_IDS);
    });

    test("an empty registry reports an empty list", async () => {
      const { emptyUrl } = target.urls();
      const { body } = await json(emptyUrl, "/health");
      expect(body.operations).toEqual([]);
    });
  });

  describe("POST /db/:name/op is fail-closed", () => {
    test("unknown and registered names are both 401", async () => {
      const { openUrl, policyUrl } = target.urls();
      const db = uniqueDb("movies");
      const unknown = await json(openUrl, `/db/${db}/op`, post({ name: "nope", input: {} }));
      expect(unknown.status).toBe(401);
      const registered = await json(policyUrl, `/db/${db}/op`, post({ name: OPERATION_IDS[0], input: {} }));
      expect(registered.status).toBe(401);
    });
  });
}
