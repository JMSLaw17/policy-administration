import { expect, type Browser, type Page } from "@playwright/test";
import { DEMO_PASSWORD } from "../src/lib/demo";

/** Shared steps for the browser tests. */

export const CARD_OK = "4242 4242 4242 4242";
export const CARD_DECLINED = "4000 0000 0000 0002";

export async function signIn(browser: Browser, email: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto("/login");
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
  return page;
}

/** Pays the amount due by typing a card into Stripe's form. */
export async function payByCard(page: Page, card: string) {
  await openPayForm(page);
  await fillCard(page, card);
  await payButton(page).click();
}

export const openPayForm = (page: Page) => page.getByRole("button", { name: /^Pay \$[\d,.]+ now$/ }).click();

/** The Pay button under Stripe's form, which carries the amount that will be collected. */
export const payButton = (page: Page) => page.locator("#pay form").getByRole("button", { name: /^Pay \$[\d,.]+$/ });

/** Types a card into Stripe's form, once it is open, and waits for the form to settle. */
export async function fillCard(page: Page, card: string) {
  // Stripe's form lives in a frame served by Stripe, which is why it needs a frame locator.
  // Stripe adds hidden helper frames with the same title, so pick the one on screen.
  const stripe = page.locator('iframe[title="Secure payment input frame"]:visible').first().contentFrame();
  await stripe.getByRole("button", { name: /^Card/ }).click();
  // Found by their labels, which are steadier than Stripe's internal ids.
  await stripe.getByLabel("Card number").fill(card);
  await stripe.getByLabel("Expiration date").fill("12 / 34");
  await stripe.getByLabel("Security code").fill("123");
  await stripe.getByLabel("Country", { exact: true }).selectOption("US");
  await stripe.getByLabel("ZIP code").fill("62701");

  // Stripe's frame grows and shrinks as fields appear, which moves the Pay
  // button. Wait until the frame has stopped changing height before clicking.
  const frame = page.locator('iframe[title="Secure payment input frame"]:visible').first();
  let height = -1;
  await expect(async () => {
    const now = (await frame.boundingBox())?.height ?? 0;
    const settled = now === height;
    height = now;
    expect(settled).toBe(true);
  }).toPass({ intervals: [300] });

  await payButton(page).scrollIntoViewIfNeeded();
}

export const balance = (page: Page) => page.getByTestId("balance");

