import * as Schema from "effect/Schema";

export const AUTHORIZATION_LANGUAGE_VERSION = "v1" as const;
export type AuthorizationLanguageVersion = typeof AUTHORIZATION_LANGUAGE_VERSION;

export const AuthorizationLanguageVersion = Schema.Literal(AUTHORIZATION_LANGUAGE_VERSION);

export const AUTHORIZATION_RULE_HASH_DOMAIN_V1 = "ramose.authorization.rule/v1\0";

export const AUTHORIZATION_POLICY_HASH_DOMAIN_V1 = "ramose.authorization.policy/v1\0";
export const AUTHORIZATION_POLICY_HASH_DOMAIN_V2 = "ramose.authorization.policy/v2\0";

export const AUTHORIZATION_CATALOG_UNIT_HASH_DOMAIN_V1 = "ramose.catalog.unit/v1\0";
export const AUTHORIZATION_CATALOG_UNIT_HASH_DOMAIN_V2 = "ramose.catalog.unit/v2\0";

export const AUTHORIZATION_CATALOG_SCHEMA_HASH_DOMAIN_V1 = "ramose.catalog.schema/v1\0";
