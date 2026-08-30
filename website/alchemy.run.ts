import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Path from "node:path";
import { fileURLToPath } from "node:url";

const here = Path.dirname(fileURLToPath(import.meta.url));

export const Website = Cloudflare.Website.StaticSite(
  "Website",
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage;

    const domain =
      process.env.RAMOSE_DOCS_DOMAIN || (stage === "prod" ? "ramose.ai" : undefined);
    return {
      cwd: here,
      command: "bun run build",
      outdir: "dist",
      compatibility: { date: "2025-06-01" as const },
      assets: { notFoundHandling: "404-page" as const },
      dev: { command: "bun run dev", url: "http://localhost:4321" },

      ...(stage === "prod" ? { name: "ripple-docs" } : {}),
      ...(domain ? { domain } : {}),
    };
  }),
);

export default Alchemy.Stack(

  "ripple-website",
  {
    providers: Cloudflare.providers(),
    state: process.env.ALCHEMY_STATE === "local" ? Alchemy.localState() : Cloudflare.state(),
  },
  Effect.gen(function* () {
    const website = yield* Website;
    return { url: website.url };
  }),
);
