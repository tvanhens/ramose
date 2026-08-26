/** Bind a template against an authoritative catalog descriptor. */

import * as Effect from "effect/Effect";
import type { CatalogDescriptor } from "../internal/authorization/descriptor.ts";
import {
  CatalogMismatch,
  HashFailure,
  InvalidInstalledIR,
  InvalidTemplate,
  RuleIdentityCollision,
} from "../internal/authorization/errors.ts";
import type { SealedInstalledAuthorizationIR } from "../internal/authorization/installed.ts";
import {
  decodeInstalledDocument,
  decodeTemplateDocument,
} from "../internal/authorization/schema.ts";
import { sealInstalled } from "../internal/authorization/seal.ts";
import { AuthorizationHash, CatalogResolver } from "../internal/authorization/services.ts";
import type { PolicyTemplateIR } from "../internal/authorization/template.ts";
import {
  bindTemplate,
  semanticallyValidateInstalled,
} from "../internal/authorization/validate.ts";

export type BindFailure =
  | InvalidTemplate
  | InvalidInstalledIR
  | CatalogMismatch
  | RuleIdentityCollision
  | HashFailure;

export const bindAuthorization = (
  template: PolicyTemplateIR | unknown,
  catalog: CatalogDescriptor,
): Effect.Effect<SealedInstalledAuthorizationIR, BindFailure, AuthorizationHash> =>
  Effect.gen(function* () {
    const hash = yield* AuthorizationHash;
    const decoded =
      typeof template === "object" &&
      template !== null &&
      (template as { readonly _tag?: unknown })._tag === "PolicyTemplateIR"
        ? decodeTemplateDocument(template)
        : decodeTemplateDocument(template);
    const digest = (canonical: string): string => Effect.runSync(hash.digest(canonical));
    const installed = bindTemplate(decoded, catalog, digest);
    return sealInstalled(installed);
  });

export const bindAuthorizationResolved = (
  template: PolicyTemplateIR | unknown,
  catalogId: string,
  catalogVersion?: string,
): Effect.Effect<
  SealedInstalledAuthorizationIR,
  BindFailure,
  AuthorizationHash | CatalogResolver
> =>
  Effect.gen(function* () {
    const resolver = yield* CatalogResolver;
    const catalog = yield* resolver.resolve(catalogId, catalogVersion);
    return yield* bindAuthorization(template, catalog);
  });

export const revalidateInstalled = (
  installed: unknown,
  catalog: CatalogDescriptor,
): Effect.Effect<SealedInstalledAuthorizationIR, BindFailure, AuthorizationHash> =>
  Effect.gen(function* () {
    const hash = yield* AuthorizationHash;
    const digest = (canonical: string): string => Effect.runSync(hash.digest(canonical));
    const decoded = decodeInstalledDocument(installed);
    const validated = semanticallyValidateInstalled(decoded, catalog, digest);
    return sealInstalled(validated);
  });
