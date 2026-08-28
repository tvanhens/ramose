/**
 * Authorization language / semantics version.
 *
 * Distinct from document-shape versions (`PolicyTemplateIR.version`,
 * `BoundAuthorizationIR.version`, …). Unknown language versions fail
 * during canonical Schema decoding. Rule and policy hashes are
 * domain-separated by this version so identical syntax cannot retain an
 * identity if later semantics change.
 */

import * as Schema from "effect/Schema";

export const AUTHORIZATION_LANGUAGE_VERSION = "v1" as const;
export type AuthorizationLanguageVersion = typeof AUTHORIZATION_LANGUAGE_VERSION;

export const AuthorizationLanguageVersion = Schema.Literal(AUTHORIZATION_LANGUAGE_VERSION);

/** Domain prefix for v1 rule-body SHA-256. Includes a trailing NUL. */
export const AUTHORIZATION_RULE_HASH_DOMAIN_V1 = "ramose.authorization.rule/v1\0";

/** Domain prefix for v1 policy-document SHA-256. Includes a trailing NUL. */
export const AUTHORIZATION_POLICY_HASH_DOMAIN_V1 = "ramose.authorization.policy/v1\0";

/** Domain prefix for v1 installed catalog-unit SHA-256. Includes a trailing NUL. */
export const AUTHORIZATION_CATALOG_UNIT_HASH_DOMAIN_V1 = "ramose.catalog.unit/v1\0";
export const AUTHORIZATION_CATALOG_UNIT_HASH_DOMAIN_V2 = "ramose.catalog.unit/v2\0";

/** Domain prefix for v1 catalog-schema-table SHA-256. Includes a trailing NUL. */
export const AUTHORIZATION_CATALOG_SCHEMA_HASH_DOMAIN_V1 = "ramose.catalog.schema/v1\0";
