/**
 * #338 capability boundaries: deny stubs fail closed, brands are not
 * `Db`, and legacy authorization names are gone from public barrels.
 */
import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  CatalogId,
  CatalogVersion,
  DatabaseId,
  OperationId,
  PolicyHash,
} from "../../../src/internal/authorization/identities.ts";
import { AuthorizationDenied } from "../../../src/internal/authorization/failures.ts";
import { AuthenticationAdmission } from "../../../src/internal/authorization/runtime/authentication.ts";
import { AuthorizedApplicationAccess } from "../../../src/internal/authorization/runtime/application-snapshot.ts";
import { CatalogLocalOperations } from "../../../src/internal/authorization/runtime/catalog-operations.ts";
import { closeConfiguredAccess, toAuthorizationDenied } from "../../../src/internal/authorization/runtime/deny.ts";
import {
  ApplicationSnapshotUnavailable,
  AuthenticationRejected,
  CatalogOperationNotFound,
  RawStorageUnavailable,
  RuleSnapshotUnavailable,
} from "../../../src/internal/authorization/runtime/failures.ts";
import { denyAllCapabilityLayer } from "../../../src/internal/authorization/runtime/layers.ts";
import { RawStorageAccess } from "../../../src/internal/authorization/runtime/raw-storage.ts";
import { RuleSnapshotAccess } from "../../../src/internal/authorization/runtime/rule-snapshot.ts";

const database = DatabaseId.make("acme");
const catalog = CatalogId.make("app");
const operation = OperationId.make({
  catalog,
  owner: { kind: "entity", name: "issue" },
  localName: "close",
  target: "required",
});

describe("fail-closed capability layers", () => {
  test("each service fails with its tagged error", async () => {
    const program = Effect.gen(function* () {
      const raw = yield* RawStorageAccess;
      const rules = yield* RuleSnapshotAccess;
      const app = yield* AuthorizedApplicationAccess;
      const ops = yield* CatalogLocalOperations;
      const auth = yield* AuthenticationAdmission;
      return {
        raw: yield* Effect.flip(raw.open({ database, basisT: 1 })),
        rules: yield* Effect.flip(rules.project({
          database,
          basisT: 1,
          policyHash: PolicyHash.make("0".repeat(64)),
          principal: { subject: "ada", claims: {}, classes: [] },
        })),
        app: yield* Effect.flip(app.open({
          database,
          basisT: 1,
          principal: { subject: "ada", claims: {}, classes: [] },
          installed: {} as never,
          leaseEpoch: 0,
        })),
        ops: yield* Effect.flip(ops.resolve({
          catalog,
          catalogVersion: CatalogVersion.make("1"),
          operation,
        })),
        auth: yield* Effect.flip(auth.admit({
          database,
          token: Redacted.make("x"),
          route: "http",
        })),
      };
    }).pipe(Effect.provide(denyAllCapabilityLayer));

    const out = await Effect.runPromise(program);
    expect(out.raw).toBeInstanceOf(RawStorageUnavailable);
    expect(out.rules).toBeInstanceOf(RuleSnapshotUnavailable);
    expect(out.app).toBeInstanceOf(ApplicationSnapshotUnavailable);
    expect(out.ops).toBeInstanceOf(CatalogOperationNotFound);
    expect(out.auth).toBeInstanceOf(AuthenticationRejected);
  });

  test("inner failures collapse through the one outer deny", async () => {
    const denied = await Effect.runPromise(Effect.flip(closeConfiguredAccess));
    expect(denied).toBeInstanceOf(AuthorizationDenied);
    const mapped = await Effect.runPromise(
      Effect.flip(toAuthorizationDenied(new RawStorageUnavailable({ message: "unwired" }))),
    );
    expect(mapped).toBeInstanceOf(AuthorizationDenied);
  });

});

describe("legacy authorization names cannot be imported", () => {
  test("public barrels do not export Policy or the old wire helpers", async () => {
    const root = await import("../../../src/index.ts");
    const db = await import("../../../src/db/index.ts");
    expect("policy" in root).toBe(false);
    expect("Policy" in root).toBe(false);
    expect("PolicyError" in db).toBe(false);
    expect("filterDb" in root).toBe(false);
    expect("parsePolicy" in root).toBe(false);
  });

  test("the IR barrel does not re-export runtime capability tags", async () => {
    const ir = await import("../../../src/internal/authorization/index.ts");
    expect("RawStorageAccess" in ir).toBe(false);
    expect("RuleSnapshotAccess" in ir).toBe(false);
    expect("AuthorizedApplicationAccess" in ir).toBe(false);
    expect("CatalogLocalOperations" in ir).toBe(false);
    expect("AuthenticationAdmission" in ir).toBe(false);
    expect("denyAllCapabilityLayer" in ir).toBe(false);
  });
});
