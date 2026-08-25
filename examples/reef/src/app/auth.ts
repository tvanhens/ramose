/**
 * The Better Auth browser client. Same-origin: in dev the Vite proxy carries
 * /api to the auth Worker; deployed, the auth Worker serves these assets.
 */

import { ramoseTokenClient } from "ramose/better-auth/client";
import { organizationClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { AUTH_BASE_PATH } from "../domain/shared.ts";
import { ac, roles } from "../domain/roles.ts";

export const authClient = createAuthClient({
  baseURL: `${window.location.origin}${AUTH_BASE_PATH}`,
  // `ramoseTokenClient` pairs with the server's `ramoseToken` plugin:
  // `authClient.ramose.token({ db })` resolves the mint route's body,
  // which `Ramose.token.jwt` accepts unchanged (app/ramose.ts).
  plugins: [organizationClient({ ac, roles }), ramoseTokenClient()],
});

export type SessionUser = {
  readonly id: string;
  readonly name: string;
  readonly email: string;
};

// ── typed wrappers over the organization endpoints ──────────────────────────
//
// Spelled with `$fetch` (explicit path + method) rather than the dynamic
// client proxy, so each call is exactly one documented Better Auth route.

export interface OrgSummary {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
}

export interface Invitation {
  readonly id: string;
  readonly email: string;
  readonly role: string;
  readonly status: string;
  readonly organizationId: string;
  readonly organizationName?: string;
  readonly organizationSlug?: string;
}

const call = async <A>(
  path: string,
  init: { method: "GET" | "POST"; query?: Record<string, string>; body?: unknown },
): Promise<A> => {
  const { data, error } = await authClient.$fetch<A>(path, init);
  if (error) throw new Error(error.message ?? `${path} failed (${error.status})`);
  return data as A;
};

export const listWorkspaces = () =>
  call<OrgSummary[]>("/organization/list", { method: "GET" });

export const createWorkspace = (name: string, slug: string) =>
  call<OrgSummary>("/organization/create", { method: "POST", body: { name, slug } });

export const inviteMember = (organizationId: string, email: string, role: string) =>
  call<Invitation>("/organization/invite-member", {
    method: "POST",
    body: { organizationId, email, role, resend: true },
  });

export const listMyInvitations = () =>
  call<Invitation[]>("/organization/list-user-invitations", { method: "GET" });

export const acceptInvitation = (invitationId: string) =>
  call<unknown>("/organization/accept-invitation", {
    method: "POST",
    body: { invitationId },
  });
