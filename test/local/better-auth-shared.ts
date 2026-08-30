import { BetterAuth } from "@alchemy.run/better-auth";
import { CloudflareD1 } from "@alchemy.run/better-auth/CloudflareD1";
import * as Cloudflare from "alchemy/Cloudflare";
import { jwt } from "better-auth/plugins/jwt";
import type { AuthConfig } from "ramose";
import { type ClassOf, ramoseToken } from "ramose/better-auth";

export const AUTH: AuthConfig = {
  issuer: "test-auth",
  audience: "ramose:test",
  ttl: 900,
};

const POLICY = { classes: ["authenticated", "member", "viewer"] as const };

export const SECRET_A = "a-test-secret-of-at-least-32-characters!";
export const SECRET_B = "a-rotated-secret-of-at-least-32-chars!!";

export const AuthDatabase = Cloudflare.D1.Database("LocalBetterAuthDatabase");

export const authDatabase = CloudflareD1(AuthDatabase);

const globalClassOf: ClassOf = ({ session }) => ({
  class: "authenticated",
  attrs: {
    ...(typeof session.user.name === "string"
      ? { name: session.user.name }
      : {}),
    ...(typeof session.user.email === "string"
      ? { email: session.user.email }
      : {}),
  },
});

export const localAuth = (
  id: string,
  basePath: string,
  secret: string,
  options: {
    readonly classOf?: ClassOf;
    readonly migrate?: boolean;
    readonly path?: string;
    readonly policy?: { readonly classes: readonly string[] };
  } = {},
) =>
  BetterAuth({
    id,
    baseURL: "http://localhost",
    basePath,
    secret,
    migrate: options.migrate ?? false,
    emailAndPassword: { enabled: true },
    plugins: [
      jwt({
        jwt: {
          issuer: AUTH.issuer,
          audience: AUTH.audience,
          expirationTime: `${AUTH.ttl}s`,
        },
      }),
      ramoseToken({
        auth: AUTH,
        policy: options.policy ?? POLICY,
        classOf: options.classOf ?? globalClassOf,
        ...(options.path === undefined ? {} : { path: options.path }),
      }),
    ],
  });

export const workerProps = (main: string): Cloudflare.WorkerProps => ({
  main,
  compatibility: {
    flags: ["nodejs_compat"],
    date: "2026-07-11",
  },
});
