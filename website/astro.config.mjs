// @ts-check
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import remarkExtractSnippets from "./scripts/remark-extract-snippets.mjs";

// Public canonical origin. The Worker keeps its physical name (`ripple-docs`,
// see alchemy.run.ts) and its workers.dev hostname; ramose.ai is the custom
// domain the site is published under.
const site = "https://ramose.ai";

export default defineConfig({
  site,
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
        "The typed, realtime database for Cloudflare. Describe your data in TypeScript, queries update themselves in every tab, users see only what your rules allow.",
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
            { label: "Before production", slug: "guides/before-production" },
            { label: "Troubleshooting and FAQ", slug: "guides/troubleshooting" },
          ],
        },
        {
          label: "Concepts",
          items: [
            { label: "How Ramose thinks about data", slug: "concepts/data-model" },
            { label: "How Ramose works", slug: "concepts/architecture" },
            { label: "Time travel", slug: "concepts/time-travel" },
            { label: "Effect in five minutes", slug: "concepts/effect" },
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
