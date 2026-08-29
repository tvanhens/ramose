/**
 * Public `/op` and minimal `/health` against a real peer.
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
  describe("GET /health exposes no deployment inventory", () => {
    test("catalog and empty peers return the same allowlisted body", async () => {
      const { openUrl } = target.urls();
      const { emptyUrl } = target.urls();
      const { status, body, res } = await json(openUrl, "/health");
      const empty = await json(emptyUrl, "/health");
      expect(status).toBe(200);
      expect(body).toEqual({ ok: true, service: "ramose" });
      expect(empty.body).toEqual(body);
      expect(res.headers.get("x-ramose-deployment")).toBeNull();
      expect(res.headers.get("x-ramose-ms")).toBeNull();
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
