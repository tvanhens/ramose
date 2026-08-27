/**
 * Request-scoped caller metadata on the session/transactor wire.
 * Not an authorization decision. JWT admission lands in #412.
 */

export interface Principal {
  readonly kind: "user";
  readonly class: string;
  readonly classes?: readonly string[];
  readonly sub?: string;
  readonly eid?: number;
  readonly claims: {
    readonly sub?: string;
    readonly iss?: string;
    readonly aud?: string;
    readonly exp?: number;
    readonly attrs?: Readonly<Record<string, unknown>>;
  };
  readonly db: string;
}
