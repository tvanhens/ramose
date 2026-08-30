import type { AuthConfig } from "ramose";
import { isDatabaseName } from "ramose/db";

export const REEF_AUTH: AuthConfig = {
  issuer: "reef-demo-auth",
  audience: "ramose:reef",
  ttl: 900,
};

export const AUTH_BASE_PATH = "/api/auth";

export const DEV_PEER_PORT = 1337;
export const DEV_API_PORT = 1338;
export const DEV_UI_ORIGIN = "http://localhost:5173";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;

const RESERVED_SLUGS: ReadonlySet<string> = new Set(["api", "db"]);

export const isWorkspaceSlug = (slug: string): boolean =>
  isDatabaseName(slug) && SLUG_RE.test(slug) && !RESERVED_SLUGS.has(slug);

export const slugify = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
