import { expect, test } from "bun:test";
import { chromium } from "playwright";

test("Reef previews a proposal, restores it after reload, and synchronizes one approved result", async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  page.on("pageerror", (error) => console.error(error.message));
  try {
    await page.goto("http://localhost:5173");
    await page.getByRole("button", { name: "New here? Create an account" }).click();
    const suffix = crypto.randomUUID().slice(0, 8);
    await page.getByPlaceholder("Name", { exact: true }).fill("Proposal Reviewer");
    await page.getByPlaceholder("Email", { exact: true }).fill(`review-${suffix}@example.com`);
    await page.getByPlaceholder("Password", { exact: true }).fill(`Review-${crypto.randomUUID()}`);
    await page.getByRole("button", { name: "Create account", exact: true }).click();
    await page.getByPlaceholder("New workspace name").fill(`Review ${suffix}`);
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await page.getByRole("heading", { name: `Review ${suffix}`, exact: true }).waitFor();
    const backlog = page.locator(".column").filter({ has: page.locator(".column-head", { hasText: "Backlog" }) });
    const todo = page.locator(".column").filter({ has: page.locator(".column-head", { hasText: "Todo" }) });
    await backlog.getByPlaceholder("Add an issue…").fill("First issue");
    await backlog.getByPlaceholder("Add an issue…").press("Enter");
    await backlog.getByPlaceholder("Add an issue…").fill("Second issue");
    await backlog.getByPlaceholder("Add an issue…").press("Enter");
    await page.waitForFunction(() => document.querySelectorAll(".card").length === 2 && document.querySelectorAll(".card-pending").length === 0);
    await page.getByRole("button", { name: "Plan next sprint" }).click();
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLButtonElement>("button")].some((button) => button.textContent === "Approve and apply" && !button.disabled));
    expect(await todo.locator(".card").count()).toBe(2);
    expect(await backlog.locator(".card").count()).toBe(0);
    const proposalId = await page.getByRole("textbox", { name: "Proposal ID" }).inputValue();
    await page.screenshot({ path: "/tmp/ramose-changeset-preview.png", fullPage: true });
    await page.getByRole("button", { name: "Return to live board" }).click();
    expect(await backlog.locator(".card").count()).toBe(2);
    await page.reload();
    await page.getByRole("textbox", { name: "Proposal ID" }).fill(proposalId);
    await page.getByRole("button", { name: "Review", exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLButtonElement>("button")].some((button) => button.textContent === "Approve and apply" && !button.disabled));
    expect(await page.getByRole("button", { name: "Approve and apply" }).isEnabled()).toBe(true);
    expect(await todo.locator(".card").count()).toBe(2);
    await page.getByRole("button", { name: "Approve and apply" }).click();
    await page.getByText("Approved. All changes were applied together.").waitFor();
    await page.waitForFunction(() => document.querySelectorAll(".column")[1]?.querySelectorAll(".card").length === 2);
    expect(await backlog.locator(".card").count()).toBe(0);
    await backlog.getByPlaceholder("Add an issue…").fill("Proposed third issue");
    await backlog.getByPlaceholder("Add an issue…").press("Enter");
    await page.waitForFunction(() => document.querySelectorAll(".card").length === 3 && document.querySelectorAll(".card-pending").length === 0);
    await page.getByRole("button", { name: "Plan next sprint" }).click();
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLButtonElement>("button")].some((button) => button.textContent === "Approve and apply" && !button.disabled));
    const other = await context.newPage();
    await other.goto(page.url());
    const otherBacklog = other.locator(".column").filter({ has: other.locator(".column-head", { hasText: "Backlog" }) });
    await otherBacklog.getByPlaceholder("Add an issue…").fill("Concurrent fourth issue");
    await otherBacklog.getByPlaceholder("Add an issue…").press("Enter");
    await page.getByRole("alert").filter({ hasText: "live board changed" }).waitFor();
    expect(await page.getByRole("button", { name: "Approve and apply" }).isDisabled()).toBe(true);
    expect(await page.getByText("Concurrent fourth issue", { exact: true }).count()).toBe(0);
    await page.getByRole("button", { name: "Discard", exact: true }).click();
    await page.getByText("Proposal discarded.").waitFor();
    await page.getByText("Concurrent fourth issue", { exact: true }).waitFor();
    await other.close();
    await page.getByRole("button", { name: "Copy agent token" }).click();
    await page.getByText("Copied a 15-minute agent token.", { exact: false }).waitFor();
    const agentClass = await page.evaluate(async () => {
      const token = await navigator.clipboard.readText();
      const payload = JSON.parse(atob(token.split(".")[1]!.replaceAll("-", "+").replaceAll("_", "/")));
      return payload.ramose.class;
    });
    expect(agentClass).toBe("agent");
  } catch (cause) {
    await page.screenshot({ path: "/tmp/ramose-changeset-failure.png", fullPage: true });
    console.error(await page.locator("body").innerText());
    throw cause;
  } finally {
    await browser.close();
  }
}, 90_000);
