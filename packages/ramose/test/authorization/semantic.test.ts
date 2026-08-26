import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Policy } from "../../src/authorization/compile.ts";
import { bindAuthorization } from "../../src/authorization/bind.ts";
import { App, catalog, compileLive, compileTaggablePolicy, Issue, User } from "./fixtures.ts";
import { AuthorizationHash, AuthorizationHashLive } from "../../src/internal/authorization/services.ts";
import { HashFailure, InvalidTemplate, RuleIdentityCollision } from "../../src/internal/authorization/errors.ts";
import { semanticallyValidateTemplate } from "../../src/internal/authorization/validate.ts";
import { sha256Hex } from "../../src/internal/authorization/hash.ts";
import { catalogDescriptorFrom } from "../../src/authorization/catalog.ts";

describe("semantic validation and tamper", () => {
  test("tampering with usesResource is rejected", () => {
    const template = compileTaggablePolicy();
    const tampered = structuredClone(template);
    const rule = tampered.rules.find((item) => item.usesResource);
    expect(rule).toBeDefined();
    (rule as { usesResource: boolean }).usesResource = false;
    expect(() =>
      semanticallyValidateTemplate(tampered, catalog, sha256Hex),
    ).toThrow();
  });

  test("tampering with a rule id is rejected", () => {
    const template = compileTaggablePolicy();
    const tampered = structuredClone(template);
    (tampered.rules[0] as { id: string }).id = "0".repeat(64);
    expect(() =>
      semanticallyValidateTemplate(tampered, catalog, sha256Hex),
    ).toThrow();
  });

  test("unknown decision keys are rejected", () => {
    const template = compileTaggablePolicy();
    const tampered = structuredClone(template);
    (tampered.decisions.rows as Record<string, unknown>).ghost = {
      allow: [],
      deny: [],
    };
    expect(() =>
      semanticallyValidateTemplate(tampered, catalog, sha256Hex),
    ).toThrow();
  });

  test("undeclared claim keys fail compilation", () => {
    expect(() =>
      compileLive(
        Policy(App, {
          principal: { subjectClaim: "sub", entity: User.authId },
          classes: [],
        }, ({ rule, read }) => [
          read(User).allow(
            rule(User, ({ claims }) => {
              void claims;
              return {
                _tag: "AuthExpr",
                expr: { _tag: "eq", left: { _tag: "claim", key: "secret" }, right: { _tag: "lit", value: "x" } },
              };
            }),
          ),
        ]),
      ),
    ).toThrow(InvalidTemplate);
  });

  test("deliberate rule-id collisions cannot silently merge", () => {
    const colliding = Layer.succeed(AuthorizationHash, {
      digest: () => Effect.succeed("aa".repeat(32)),
    });
    const program = Policy(App, {
      principal: { subjectClaim: "sub" },
      classes: [],
    }, ({ rule, read, always }) => [
      read(User).allow(rule(User, ({ resource }) => resource.name.eq("a"))),
      read(Issue).allow(always),
    ]).pipe(Effect.provide(colliding));

    expect(() => Effect.runSync(program)).toThrow(RuleIdentityCollision);
  });

  test("hash failures surface as typed failures", () => {
    const failing = Layer.succeed(AuthorizationHash, {
      digest: () =>
        Effect.fail(new HashFailure({ message: "digest unavailable" })),
    });
    const exit = Effect.runSyncExit(
      Policy(App, { principal: { subjectClaim: "sub" } }, ({ read, always }) => [
        read(User).allow(always),
      ]).pipe(Effect.provide(failing)),
    );
    expect(exit._tag).toBe("Failure");
  });

  test("parser path cannot bypass compiler restrictions", () => {
    const template = compileTaggablePolicy();
    const tampered = {
      ...structuredClone(template),
      rules: structuredClone(template.rules).map((rule, index) =>
        index === 0
          ? {
              ...rule,
              expr: {
      _tag: "exists",
      entity: { name: "issue" },
      bind: "a",
      pred: {
        _tag: "exists",
        entity: { name: "issue" },
        bind: "b",
        pred: {
          _tag: "exists",
          entity: { name: "issue" },
          bind: "c",
          pred: {
            _tag: "exists",
            entity: { name: "issue" },
            bind: "d",
            pred: {
              _tag: "exists",
              entity: { name: "issue" },
              bind: "e",
              pred: { _tag: "const", value: true },
            },
          },
        },
      },
              },
            }
          : rule,
      ),
    };
    expect(() =>
      semanticallyValidateTemplate(tampered as typeof template, catalog, sha256Hex),
    ).toThrow();
  });

  test("relative catalog from schema is accepted by bind", () => {
    const template = compileTaggablePolicy();
    const relative = catalogDescriptorFrom({
      catalogId: "app",
      catalogVersion: "v1",
      schema: App,
      operations: [],
      fingerprint: catalog.fingerprint,
    });
    void relative;
    const installed = compileLive(bindAuthorization(template, catalog));
    expect(installed.catalogId).toBe("app");
  });
});

void AuthorizationHashLive;
