import "./env.ts";
import { describe, expect, test, setDefaultTimeout } from "bun:test";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Bun";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ramose from "ramose";
import { chromium } from "playwright";
import type { BetterAuthProvider } from "../../packages/ramose/src/better-auth/client.ts";
import Stack from "../../examples/reef/alchemy.run.ts";

setDefaultTimeout(120_000);
const { deploy, destroy, beforeAll, afterAll } = Test.make({
  providers: Layer.mergeAll(Cloudflare.providers(), Ramose.providers()),
  state: Alchemy.inMemoryState(),
  stage: "reef-test",
  dev: true,
});
const deployed = beforeAll(deploy(Stack));
afterAll(destroy(Stack));

describe("Reef through its public Worker", () => {
  test("the credential provider caches, renews, survives offline, and closes on sign-out", async () => {
    const { appUrl } = Effect.runSync(deployed);
    if (appUrl === undefined) throw new Error("Reef has no public URL");
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(`${appUrl}/api/health`);
      const signup = await page.evaluate(async (email) => {
        const response = await fetch("/api/auth/sign-up/email", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Credential tester", email, password: "credential-password-1234" }),
        });
        return { status: response.status, body: await response.json() };
      }, `credentials-${crypto.randomUUID()}@example.test`);
      expect(signup.status).toBe(200);
      const userId: string = (signup.body as { user: { id: string } }).user.id;
      const built = await Bun.build({
        entrypoints: ["packages/ramose/src/better-auth/client.ts"],
        target: "browser",
      });
      expect(built.success).toBe(true);
      const code = await built.outputs[0]!.text();
      const provider = await page.evaluateHandle(async ({ code, userId }) => {
        const module = await import(URL.createObjectURL(new Blob([code], { type: "text/javascript" })));
        return module.createAuthProvider({ userId }) as BetterAuthProvider;
      }, { code, userId });
      let requests = 0;
      page.on("request", (request) => { if (request.url().endsWith("/ramose/token")) requests++; });
      const first = await provider.evaluate(async (get) => get());
      expect(first.cacheKey).toBe(userId);
      expect(requests).toBe(1);
      expect(await provider.evaluate(async (get) => get())).toEqual(first);
      expect(requests).toBe(1);
      const restored = await page.evaluate(async ({ code, userId }) => {
        const module = await import(URL.createObjectURL(new Blob([code], { type: "text/javascript" })));
        return module.createAuthProvider({ userId })();
      }, { code, userId });
      expect(restored).toEqual(first);
      expect(requests).toBe(1);
      await page.evaluate(() => {
        const key = Object.keys(localStorage).find((key) => key.startsWith("ramose:bearer:"))!;
        localStorage.setItem(key, JSON.stringify({ token: 42, exp: Date.now() / 1000 + 900 }));
      });
      expect((await provider.evaluate(async (get) => get())).cacheKey).toBe(userId);
      expect(requests).toBe(2);
      const expire = () => page.evaluate(() => {
        for (const key of Object.keys(localStorage).filter((key) => key.startsWith("ramose:bearer:"))) {
          const saved = JSON.parse(localStorage.getItem(key)!);
          localStorage.setItem(key, JSON.stringify({ ...saved, exp: 1 }));
        }
      });
      await expire();
      const renewed = await provider.evaluate(async (get) => Promise.all([get(), get(), get()]));
      expect(renewed.every((item) => item.token === renewed[0]!.token)).toBe(true);
      expect(requests).toBe(3);
      await expire();
      await context.setOffline(true);
      expect(await provider.evaluate(async (get) => get())).toEqual(renewed[0]!);
      await context.setOffline(false);
      await context.clearCookies();
      expect(await provider.evaluate(async (get) => {
        try { await get(); return false; } catch { return true; }
      })).toBe(true);
      expect(await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("ramose:bearer:")).length)).toBe(0);
      await context.setOffline(true);
      expect(await provider.evaluate(async (get) => {
        try { await get(); return false; } catch { return true; }
      })).toBe(true);
      await context.setOffline(false);
      await provider.evaluate((get) => get.clear());
      expect(await provider.evaluate(async (get) => {
        try { await get(); return false; } catch { return true; }
      })).toBe(true);
    } finally { await browser.close(); }
  });

  test("signs in, writes by workspace reference, and reports operation failures", async () => {
    const { appUrl } = Effect.runSync(deployed);
    if (appUrl === undefined) throw new Error("Reef has no public URL");
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      page.on("pageerror", (error) => console.error(error));
      await page.goto(appUrl);
      await page.getByRole("button", { name: "New here? Create an account" }).click();
      await page.getByPlaceholder("Name", { exact: true }).fill("Reef tester");
      await page.getByPlaceholder("Email", { exact: true }).fill(`reef-${crypto.randomUUID()}@example.test`);
      await page.getByPlaceholder("Password", { exact: true }).fill("reef-password-1234");
      const signupResponse = page.waitForResponse((response) => response.url().endsWith("/sign-up/email"));
      await page.getByRole("button", { name: "Create account", exact: true }).click();
      const signedUp = await signupResponse;
      if (!signedUp.ok()) throw new Error(await signedUp.text());
      await page.getByPlaceholder("New workspace name").fill("Release board");
      await page.getByRole("button", { name: "Create", exact: true }).click();
      await page.getByRole("heading", { name: "Release board", exact: true }).waitFor();
      const title = page.getByPlaceholder("Add an issue…").first();
      await title.fill("Ship the release");
      await title.press("Enter");
      await page.locator(".card-title", { hasText: "Ship the release" }).waitFor();
      await page.locator(".mutation-feedback", { hasText: "Create issue: Saved" }).waitFor();
      await page.locator(".card-title", { hasText: "Ship the release" }).click();
      await page.getByPlaceholder("Write a comment…").fill("Typed references work");
      await page.getByPlaceholder("Write a comment…").press("Enter");
      await page.locator(".comment-body", { hasText: "Typed references work" }).waitFor();
      await page.getByPlaceholder("Visible to the issue creator only — a field-level policy rule").fill("Creator-only note");
      await page.getByPlaceholder("Write a comment…").click();
      await page.locator(".mutation-feedback", { hasText: "Set private note: Saved" }).waitFor();
      await page.reload();
      await page.locator(".card-title", { hasText: "Ship the release" }).waitFor();
      await page.locator(".card-title", { hasText: "Ship the release" }).click();
      expect(await page.getByPlaceholder("Visible to the issue creator only — a field-level policy rule").inputValue()).toBe("Creator-only note");
      const forged = await fetch(`${appUrl}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://untrusted.example", "x-reef-origin": "https://untrusted.example" },
        body: JSON.stringify({ name: "Untrusted", email: "untrusted@example.test", password: "untrusted-password" }),
      });
      expect(forged.status).toBe(403);
      expect((await page.request.get(`${appUrl}/api/auth/jwks`)).status()).toBe(200);
      expect((await page.request.get(`${appUrl}/db/probe/info`)).headers()["content-type"]).toContain("application/json");
      await page.getByRole("link", { name: "Reef", exact: true }).click();
      await page.getByPlaceholder("New workspace name").fill("Release board");
      await page.getByRole("button", { name: "Create", exact: true }).click();
      await page.locator('.mutation-feedback [role="alert"]', { hasText: "Create workspace" }).waitFor();
    } finally { await browser.close(); }
  });
});
