// @ts-check
import starlight from "@astrojs/starlight";
import { wgslVitePlugin } from "vgpu/client";
import { defineConfig } from "astro/config";
import remarkExtractSnippets from "./scripts/remark-extract-snippets.mjs";

const site = "https://ramose.ai";

export default defineConfig({
  site,
  vite: {
    plugins: [wgslVitePlugin()],
  },
  markdown: {
    remarkPlugins: [remarkExtractSnippets],
  },

  redirects: {
    "/guides/auth/": "/reference/policy/",
    "/concepts/databases-are-names/": "/guides/workspaces/",
    "/concepts/for-datomic-users/":
      "/concepts/data-model/#where-the-ideas-come-from",
    "/reference/alchemy-resources/":
      "/guides/deploy/#reference-the-ramose-resources",
    "/reference/http-api/": "/reference/server/#http-api",
    "/reference/configuration/": "/reference/server/#configuration",
    "/reference/runbook/": "/reference/server/#operations",
    "/getting-started/first-app/": "/getting-started/quickstart/",
    "/guides/workspaces/": "/guides/subgraphs/",
    "/guides/live-queries/": "/guides/react/",
  },
  integrations: [
    starlight({
      title: "Ramose",

      description:
        "One offline-first database for your app and its agents, with generated MCP tools and exactly the same permissions for both.",
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
              "Ramose — the database optimized for humans and agents",
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
        "@fontsource-variable/space-grotesk",
        "@fontsource-variable/jetbrains-mono",
        "./src/styles/theme.css",
      ],
      components: {
        SiteTitle: "./src/components/SiteTitle.astro",
        ThemeProvider: "./src/components/ThemeProvider.astro",
        ThemeSelect: "./src/components/ThemeSelect.astro",
      },
      expressiveCode: {

        themes: ["vesper"],
        styleOverrides: {
          borderRadius: "0.625rem",
          borderColor: "#282523",
          frames: {
            editorBackground: "#0d0d0d",
            terminalBackground: "#0d0d0d",
            terminalTitlebarBackground: "#111111",
            editorTabBarBackground: "#111111",
            editorActiveTabBackground: "#0d0d0d",
            editorActiveTabIndicatorTopColor: "#ff6500",
            editorTabBarBorderBottomColor: "#282523",
            frameBoxShadowCssValue: "none",
          },
          codeBackground: "#0d0d0d",
          codeFontSize: "0.8125rem",
        },
      },
      sidebar: [
        {
          label: "Start here",
          items: [
            { label: "What is Ramose", slug: "getting-started/introduction" },
            { label: "Mental model", slug: "concepts/mental-model" },
            { label: "Build a web app", slug: "getting-started/quickstart" },
            { label: "Connect an agent", slug: "getting-started/connect-an-agent" },
            { label: "How it compares", slug: "getting-started/compare" },
          ],
        },
        {
          label: "Build",
          items: [
            { label: "Schemas and traits", slug: "guides/catalog" },
            { label: "Graphs and subgraphs", slug: "guides/subgraphs" },
            { label: "Read data", slug: "guides/queries" },
            { label: "Mutate data", slug: "guides/transactions" },
            { label: "React and offline UX", slug: "guides/react" },
            { label: "Permissions", slug: "guides/permissions" },
            { label: "Authentication", slug: "guides/sign-in" },
            { label: "Add MCP", slug: "guides/mcp" },
          ],
        },
        {
          label: "Deep dives",
          items: [
            { label: "Graph of graphs", slug: "concepts/graph-of-graphs" },
            { label: "Data model", slug: "concepts/data-model" },
            { label: "Query model", slug: "concepts/queries" },
            { label: "Operations", slug: "concepts/operations" },
            { label: "Offline and sync", slug: "concepts/offline" },
            { label: "Authorization", slug: "concepts/authorization" },
            { label: "History and time", slug: "concepts/time-travel" },
            { label: "Architecture", slug: "concepts/architecture" },
            { label: "Effect (advanced)", slug: "concepts/effect" },
          ],
        },
        {
          label: "Best practices",
          items: [
            { label: "Model domains", slug: "best-practices/data-modeling" },
            { label: "Graph boundaries", slug: "best-practices/graph-boundaries" },
            { label: "Query performance", slug: "best-practices/query-performance" },
            { label: "Operations and offline", slug: "best-practices/operations" },
            { label: "Security", slug: "best-practices/security" },
          ],
        },
        {
          label: "Ship and operate",
          items: [
            { label: "Deploy", slug: "guides/deploy" },
            { label: "Use it from a Worker", slug: "guides/workers" },
            { label: "Read on the server", slug: "guides/ssr" },
            { label: "Before production", slug: "guides/before-production" },
            { label: "Troubleshooting", slug: "guides/troubleshooting" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "Schema and traits", slug: "reference/schema" },
            { label: "Client API", slug: "reference/client-api" },
            { label: "Query builder", slug: "reference/query-language" },
            { label: "QueryDocument v1", slug: "reference/query-document" },
            { label: "Operations", slug: "reference/operations" },
            { label: "React", slug: "reference/react" },
            { label: "Offline limits", slug: "reference/offline-limits" },
            { label: "MCP", slug: "reference/mcp" },
            { label: "Policy", slug: "reference/policy" },
            { label: "Errors", slug: "reference/errors" },
            { label: "The server", slug: "reference/server" },
            { label: "Glossary", slug: "concepts/glossary" },
          ],
        },
      ],
    }),
  ],
});
