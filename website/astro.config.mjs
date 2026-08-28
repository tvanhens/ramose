// @ts-check
import starlight from "@astrojs/starlight";
import { wgslVitePlugin } from "vgpu/client";
import { defineConfig } from "astro/config";
import remarkExtractSnippets from "./scripts/remark-extract-snippets.mjs";

// Public canonical origin. The Worker keeps its physical name (`ripple-docs`,
// see alchemy.run.ts) and its workers.dev hostname; ramose.ai is the custom
// domain the site is published under.
const site = "https://ramose.ai";

export default defineConfig({
  site,
  vite: {
    plugins: [wgslVitePlugin()],
  },
  markdown: {
    remarkPlugins: [remarkExtractSnippets],
  },
  // Old URLs from before the docs overhaul. Astro emits a static
  // meta-refresh page per entry; fragments are kept in the target URL.
  // These stubs have no <html> element, so every build Pagefind logs
  // "7 pages found without an <html> element" and skips them. Expected.
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
    // Quickstart and "Build your first app" were consolidated into one
    // Getting started guide, which keeps the /quickstart/ URL.
    "/getting-started/first-app/": "/getting-started/quickstart/",
  },
  integrations: [
    starlight({
      title: "Ramose",
      // Default meta description for any page without its own (today: /404).
      // Keep it under 160 characters — Google truncates around there.
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
        // `vesper` gives us a restrained, near-monochrome base. Frame chrome
        // is pinned to the brand's black / graphite / orange palette below so
        // code blocks sit on the same surfaces as the rest of the page.
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
          label: "Start",
          items: [
            { label: "What is Ramose", slug: "getting-started/introduction" },
            { label: "Getting started", slug: "getting-started/quickstart" },
            { label: "Tour of Reef", slug: "getting-started/tour-of-reef" },
            { label: "How it compares", slug: "getting-started/compare" },
          ],
        },
        {
          label: "Build",
          items: [
            { label: "Define your data", slug: "guides/catalog" },
            { label: "Write data", slug: "guides/transactions" },
            { label: "Read data", slug: "guides/queries" },
            { label: "Live queries", slug: "guides/live-queries" },
            { label: "Permissions", slug: "guides/permissions" },
            { label: "Sign in and roles", slug: "guides/sign-in" },
            { label: "One database per customer", slug: "guides/workspaces" },
          ],
        },
        {
          label: "Ship",
          items: [
            { label: "Deploy", slug: "guides/deploy" },
            { label: "Use it from a Worker", slug: "guides/workers" },
            { label: "Read on the server", slug: "guides/ssr" },
            { label: "Before production", slug: "guides/before-production" },
            { label: "Troubleshooting and FAQ", slug: "guides/troubleshooting" },
            { label: "Effect (advanced)", slug: "concepts/effect" },
          ],
        },
        {
          label: "Concepts",
          items: [
            { label: "How Ramose thinks about data", slug: "concepts/data-model" },
            { label: "How Ramose works", slug: "concepts/architecture" },
            { label: "Time travel", slug: "concepts/time-travel" },
            { label: "Glossary", slug: "concepts/glossary" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "Client API", slug: "reference/client-api" },
            { label: "The query language", slug: "reference/query-language" },
            { label: "React hooks", slug: "reference/react" },
            { label: "Policy", slug: "reference/policy" },
            { label: "Errors", slug: "reference/errors" },
            { label: "The server", slug: "reference/server" },
          ],
        },
      ],
    }),
  ],
});
