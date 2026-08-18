// @ts-check
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://ripple-docs.tvanhens.workers.dev",
  integrations: [
    starlight({
      title: "Ripple",
      description:
        "Ripple is a typed, realtime database for apps you ship on Cloudflare: TypeScript schema, queries that update themselves, and per-user permissions, all running in your own Cloudflare account.",
      favicon: "/favicon.svg",
      head: [
        {
          tag: "meta",
          attrs: {
            property: "og:image",
            content: "https://ripplegraph.ai/og.png",
          },
        },
        { tag: "meta", attrs: { property: "og:image:width", content: "1200" } },
        { tag: "meta", attrs: { property: "og:image:height", content: "630" } },
        {
          tag: "meta",
          attrs: {
            property: "og:image:alt",
            content:
              "Ripple — the typed, realtime database for Cloudflare",
          },
        },
        {
          tag: "meta",
          attrs: {
            name: "twitter:image",
            content: "https://ripplegraph.ai/og.png",
          },
        },
      ],
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/tvanhens/ripple",
        },
      ],
      editLink: {
        baseUrl: "https://github.com/tvanhens/ripple/edit/master/website/",
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
        // Warm-dark, sand foreground, moss-family strings — the brand palette,
        // not GitHub's blues. Backgrounds are pinned to the site's void below.
        themes: ["everforest-dark"],
        styleOverrides: {
          borderRadius: "0.625rem",
          borderColor: "#2a2a25",
          frames: {
            editorBackground: "#0b0b09",
            terminalBackground: "#0b0b09",
            terminalTitlebarBackground: "#131310",
            editorTabBarBackground: "#131310",
            editorActiveTabBackground: "#0b0b09",
            editorActiveTabIndicatorTopColor: "#879b45",
            editorTabBarBorderBottomColor: "#2a2a25",
            frameBoxShadowCssValue: "none",
          },
          codeBackground: "#0b0b09",
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
              link: "https://github.com/tvanhens/ripple/tree/master/examples/reef",
              attrs: { target: "_blank" },
            },
            {
              label: "Todos — React + live queries",
              link: "https://github.com/tvanhens/ripple/tree/master/examples/todos",
              attrs: { target: "_blank" },
            },
            {
              label: "Multi-tenant Worker",
              link: "https://github.com/tvanhens/ripple/tree/master/examples/kv-style",
              attrs: { target: "_blank" },
            },
          ],
        },
      ],
    }),
  ],
});
