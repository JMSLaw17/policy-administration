import { expect, test, type Page } from "@playwright/test";
import { DEMO_PASSWORD } from "../src/lib/demo";

/**
 * Read-only smoke check of a deployed copy of the app. It signs in, opens each
 * main page and the first policy it can find, and fails on any error page or
 * failed response. It never submits a form other than the sign-in form.
 */

async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

async function opens(page: Page, path: string) {
  const response = await page.goto(path);
  expect(response?.status(), `${path} status`).toBeLessThan(400);
  await expect(page.locator("body")).not.toContainText(/Application error|Internal Server Error|This page could not be found/);
}

/** Opens the first link on the page that matches selector, if there is one. */
async function opensFirstLink(page: Page, selector: string) {
  const link = page.locator(selector).first();
  if ((await link.count()) === 0) return;
  const href = await link.getAttribute("href");
  await opens(page, href!);
}

test("broker pages load", async ({ page }) => {
  await signIn(page, "broker@demo.test");
  for (const path of ["/broker/commissions", "/broker/integrations"]) {
    await opens(page, path);
  }
  await opens(page, "/broker");
  await opensFirstLink(page, 'a[href^="/broker/policies/"]');
  await opens(page, "/broker");
  await opensFirstLink(page, 'a[href^="/broker/customers/"]:not([href$="/new"])');
});

test("policyholder pages load", async ({ page }) => {
  await signIn(page, "owner@acme-bakery.test");
  await opens(page, "/portal");
  await opensFirstLink(page, 'a[href^="/portal/policies/"]');
});

test("a wrong password is refused", async ({ page }) => {
  await page.goto("/login");
  await page.locator('input[name="email"]').fill("broker@demo.test");
  await page.locator('input[name="password"]').fill("not-the-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("That email and password don't match.")).toBeVisible();
});
