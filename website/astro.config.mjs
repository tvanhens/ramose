// @ts-check
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

// Public canonical origin. The Worker keeps its physical name (`ripple-docs`,
// see alchemy.run.ts) and its workers.dev hostname; ramose.ai is the custom
// domain the site is published under.
const site = "https://ramose.ai";

export default defineConfig({
  site,
  integrations: [
    starlight({
      title: "Ramose",
      description:
        "Ramose is a typed, realtime database for apps you ship on Cloudflare: TypeScript schema, queries that update themselves, and per-user permissions, all running in your own Cloudflare account.",
      favicon: "/favicon.svg",
      head: [
        {
          tag: "meta",
          attrs: {
            property: "og:image",
            content: `${site}/og.png`,
          },
        },
        { tag: "meta", attrs: { property: "og:image:width", content: "1200" } },
        { tag: "meta", attrs: { property: "og:image:height", content: "630" } },
        {
          tag: "meta",
          attrs: {
            property: "og:image:alt",
            content:
              "Ramose — the typed, realtime database for Cloudflare",
          },
        },
        {
          tag: "meta",
          attrs: {
            name: "twitter:image",
            content: `${site}/og.png`,
          },
        },
      ],
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/tvanhens/ramose",
        },
      ],
      editLink: {
        baseUrl: "https://github.com/tvanhens/ramose/edit/master/website/",
      },
      customCss: [
        "@fontsource-variable/manrope",
        "./src/styles/theme.css",
      ],
      components: {
        SiteTitle: "./src/components/SiteTitle.astro",
        ThemeProvider: "./src/components/ThemeProvider.astro",
        ThemeSelect: "./src/components/ThemeSelect.astro",
      },
      expressiveCode: {
        // `vesper` — a near-monochrome black theme whose one chromatic accent
        // is mint/green on white text. It reads as the ramose.ai palette
        // (deep black surface, green signal) rather than GitHub's blues.
        // Backgrounds are pinned to the brand's black / dark forest below so
        // code blocks sit on the same surfaces as the rest of the page.
        themes: ["vesper"],
        styleOverrides: {
          borderRadius: "0.625rem",
          borderColor: "#1c2a21",
          frames: {
            editorBackground: "#0d0d0d",
            terminalBackground: "#0d0d0d",
            terminalTitlebarBackground: "#0b1a10",
            editorTabBarBackground: "#0b1a10",
            editorActiveTabBackground: "#0d0d0d",
            editorActiveTabIndicatorTopColor: "#42d37a",
            editorTabBarBorderBottomColor: "#1c2a21",
            frameBoxShadowCssValue: "none",
          },
          codeBackground: "#0d0d0d",
          codeFontSize: "0.8125rem",
        },
      },
      sidebar: [
        {
          label: "Getting started",
          items: [
            { label: "Introduction", slug: "getting-started/introduction" },
            { label: "Quickstart", slug: "getting-started/quickstart" },
          ],
        },
        {
          label: "Build",
          items: [
            { label: "Define your data", slug: "guides/catalog" },
            { label: "Write data", slug: "guides/transactions" },
            { label: "Query and pull", slug: "guides/queries" },
            { label: "Live queries", slug: "guides/live-queries" },
            { label: "Permissions", slug: "guides/permissions" },
          ],
        },
        {
          label: "Ship",
          items: [
            { label: "Deploy with Alchemy", slug: "guides/deploy" },
            { label: "Workers and tenants", slug: "guides/workers" },
            { label: "Before production", slug: "guides/before-production" },
          ],
        },
        {
          label: "Concepts",
          items: [
            { label: "Architecture", slug: "concepts/architecture" },
            { label: "A database is a name", slug: "concepts/databases-are-names" },
            { label: "Time travel", slug: "concepts/time-travel" },
            { label: "For Datomic users", slug: "concepts/for-datomic-users" },
            { label: "Auth and policy", slug: "guides/auth" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "Client API", slug: "reference/client-api" },
            { label: "React", slug: "reference/react" },
            { label: "Alchemy resources", slug: "reference/alchemy-resources" },
            { label: "HTTP API", slug: "reference/http-api" },
            { label: "Errors", slug: "reference/errors" },
            { label: "Configuration", slug: "reference/configuration" },
            { label: "Runbook", slug: "reference/runbook" },
          ],
        },
        {
          label: "Examples",
          items: [
            {
              label: "Reef — multi-tenant issue tracker",
              link: "https://github.com/tvanhens/ramose/tree/master/examples/reef",
              attrs: { target: "_blank" },
            },
            {
              label: "Todos — React + live queries",
              link: "https://github.com/tvanhens/ramose/tree/master/examples/todos",
              attrs: { target: "_blank" },
            },
            {
              label: "Multi-tenant Worker",
              link: "https://github.com/tvanhens/ramose/tree/master/examples/kv-style",
              attrs: { target: "_blank" },
            },
          ],
        },
      ],
    }),
  ],
});
