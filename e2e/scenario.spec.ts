import { expect, test, type Browser, type Page } from "@playwright/test";
import { DEMO_PASSWORD } from "../src/lib/demo";

/**
 * The scenario the reviewers will test, driven through the real screens in a
 * real browser, with real Stripe test-mode payments typed into Stripe's card
 * form:
 *
 *   A customer has paid for their policy and an additional coverage change.
 *   Three weeks later, the broker discovers that the extra coverage began a
 *   week earlier than recorded. Correct the effective date and show the
 *   revised amount due, keeping the original charge and the correction visible.
 *
 * It then goes on to a declined card, and a correction the other way that
 * refunds the customer.
 */

const CARD_OK = "4242 4242 4242 4242";
const CARD_DECLINED = "4000 0000 0000 0002";

async function signIn(browser: Browser, email: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto("/login");
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
  return page;
}

/** Pays the amount due by typing a card into Stripe's form. */
async function payByCard(page: Page, card: string) {
  await page.getByRole("button", { name: /^Pay \$[\d,.]+ now$/ }).click();
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

  const pay = page.locator("#pay form").getByRole("button", { name: /^Pay \$[\d,.]+$/ });
  await pay.scrollIntoViewIfNeeded();
  await pay.click();
}

const balance = (page: Page) => page.getByTestId("balance");

test("pay, add coverage, pay, correct the date, decline, pay, correct again with a refund", async ({ browser }) => {
  const broker = await signIn(browser, "broker@demo.test");
  const holder = await signIn(browser, "owner@acme-bakery.test");

  await test.step("broker issues a policy from Oct 1", async () => {
    await broker.getByRole("link", { name: "Acme Bakery LLC" }).click();
    await broker.locator('input[name="startDate"]').fill("2026-10-01");
    await expect(broker.getByTestId("issue-total")).toHaveText("$1,095.00");
    await broker.getByRole("button", { name: "Issue policy" }).click();
    await expect(broker).toHaveURL(/\/broker\/policies\//);
    await expect(balance(broker)).toHaveText("$1,095.00");
  });
  const policyId = broker.url().split("/broker/policies/")[1].split(/[?#]/)[0];
  const holderPolicy = `/portal/policies/${policyId}`;

  await test.step("policyholder pays the premium by card", async () => {
    await holder.goto(holderPolicy);
    await expect(balance(holder)).toHaveText("$1,095.00");
    await payByCard(holder, CARD_OK);
    await expect(balance(holder)).toHaveText("$0.00");
    await expect(holder.getByText("Paid in full")).toBeVisible();
    await expect(holder.locator("#statement")).toContainText("Payment received (card ending 4242)");
  });

  await test.step("broker adds Cyber, recorded as starting Nov 1", async () => {
    await broker.reload();
    const card = broker.locator("#edit-coverage");
    await card.locator('input[name="effectiveDate"]').fill("2026-11-01");
    await card.locator('input[value="CYBER"]').check();
    await card.getByRole("button", { name: "Preview change" }).click();
    await expect(card.getByTestId("preview")).toContainText("$730.00 × 334 ÷ 365 days = $668.00");
    await expect(card.getByTestId("preview-after")).toHaveText("$668.00");
    await card.getByRole("button", { name: "Confirm coverage change" }).click();
    await expect(balance(broker)).toHaveText("$668.00");
  });

  await test.step("policyholder pays for the added coverage", async () => {
    await holder.reload();
    await expect(balance(holder)).toHaveText("$668.00");
    await payByCard(holder, CARD_OK);
    await expect(balance(holder)).toHaveText("$0.00");
  });

  await test.step("broker corrects the start date to Oct 25, a week earlier", async () => {
    await broker.reload();
    await broker.locator("#history-2").getByRole("button", { name: "Correct this" }).click();
    const form = broker.getByTestId("correct-2");
    await form.locator('input[name="correctedDate"]').fill("2026-10-25");
    await form.locator('input[name="correctionReason"]').fill("Coverage began a week earlier than recorded");
    await form.getByRole("button", { name: "Preview correction" }).click();
    const preview = form.getByTestId("preview");
    await expect(preview).toContainText("Reversal: Cyber Liability: added from Nov 1, 2026");
    await expect(preview).toContainText("-$668.00");
    await expect(preview).toContainText("$730.00 × 341 ÷ 365 days = $682.00");
    await expect(form.getByTestId("preview-after")).toHaveText("$14.00");
    await form.getByRole("button", { name: "Confirm correction" }).click();
    await expect(balance(broker)).toHaveText("$14.00");
  });

  await test.step("both roles see the original charge, the reversal, the new charge, and why", async () => {
    await holder.reload();
    for (const page of [broker, holder]) {
      await expect(balance(page)).toHaveText("$14.00");
      const statement = page.locator("#statement");
      await expect(statement).toContainText("Cyber Liability: added from Nov 1, 2026"); // the original, still there
      await expect(statement).toContainText("Superseded by correction #3");
      await expect(statement).toContainText("Reversal: Cyber Liability: added from Nov 1, 2026");
      await expect(statement).toContainText("Cyber Liability: added from Oct 25, 2026");
      await expect(page.getByTestId("explanation")).toHaveText(
        "What this means: Cyber Liability now counts 7 more days (341 instead of 334) at $2.00 a day, so its charge changes from $668.00 to $682.00. In total, $14.00 more is owed.",
      );
    }
    // The policyholder can read the correction but can't make one.
    await expect(holder.getByRole("button", { name: "Correct this" })).toHaveCount(0);
  });

  await test.step("a declined card is shown as failed and nothing is paid", async () => {
    await payByCard(holder, CARD_DECLINED);
    await expect(holder.getByTestId("payment-error")).toContainText(/declined/i);
    await holder.reload();
    await expect(balance(holder)).toHaveText("$14.00");
    await expect(holder.locator("#payments")).toContainText("Failed");
  });

  await test.step("policyholder pays the $14.00", async () => {
    await payByCard(holder, CARD_OK);
    await expect(balance(holder)).toHaveText("$0.00");
  });

  await test.step("broker corrects the date the other way, and the customer is refunded", async () => {
    await broker.reload();
    await broker.locator("#history-3").getByRole("button", { name: "Correct this" }).click();
    const form = broker.getByTestId("correct-3");
    await form.locator('input[name="correctedDate"]').fill("2026-11-08");
    await form.getByRole("button", { name: "Preview correction" }).click();
    // 14 fewer days than Oct 25, at $2.00 a day.
    await expect(form.getByTestId("preview")).toContainText("Credit to refund to the customer");
    await expect(form.getByTestId("preview-after")).toHaveText("$28.00");
    await form.getByRole("button", { name: "Confirm correction" }).click();

    await expect(balance(broker)).toHaveText("$0.00");
    await expect(broker.locator("#statement")).toContainText("Refund sent to your original payment method");
    const refunds = broker.locator("#payments").getByRole("row").filter({ hasText: "Refund of" });
    await expect(refunds).toContainText(["$14.00", "$14.00"]); // newest payment first, then the next
    await expect(refunds.filter({ hasText: "Succeeded" })).toHaveCount(2);

    await holder.reload();
    await expect(balance(holder)).toHaveText("$0.00");
    await expect(holder.locator("#statement")).toContainText("Refund sent to your original payment method");
  });
});
