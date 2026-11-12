import { expect, test } from "@playwright/test";
import { DEMO_PASSWORD } from "../src/lib/demo";
import { balance, CARD_DECLINED, CARD_OK, payByCard, signIn } from "./helpers";

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
    // The policyholder is told why $14.00 is due, right beside the Pay button.
    const why = holder.locator("#pay").getByTestId("due-reasons");
    await expect(why).toContainText("Correction to #2");
    await expect(why).toContainText("Effective date corrected from Nov 1, 2026 to Oct 25, 2026.");
    await expect(why).toContainText("In total, $14.00 more is owed.");
    await expect(why).toContainText("Reason: Coverage began a week earlier than recorded");
    await expect(why).toContainText("+$14.00");
    // The statement adds up in one row: premium − payments + refunds = amount due.
    for (const page of [broker, holder]) {
      const summary = page.getByTestId("statement-summary");
      await expect(summary.getByTestId("summary-premium")).toHaveText("$1,777.00");
      await expect(summary.getByTestId("summary-payments")).toHaveText("$1,763.00");
      await expect(summary.getByTestId("summary-refunds")).toHaveText("$0.00");
      await expect(summary.getByTestId("summary-balance")).toHaveText("$14.00");
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
    // 327 days of Cyber at $2.00, all of it paid, with the $28.00 difference sent back.
    const summary = holder.getByTestId("statement-summary");
    await expect(summary.getByTestId("summary-premium")).toHaveText("$1,749.00");
    await expect(summary.getByTestId("summary-payments")).toHaveText("$1,777.00");
    await expect(summary.getByTestId("summary-refunds")).toHaveText("$28.00");
    await expect(summary.getByTestId("summary-balance")).toHaveText("$0.00");
  });
});

test("a button keeps its size and shows a spinner while it works", async ({ page }) => {
  await page.goto("/login");
  await page.locator('input[name="email"]').fill("broker@demo.test");
  await page.locator('input[name="password"]').fill(DEMO_PASSWORD);

  // Hold the sign-in request back so the busy state can be measured.
  await page.route("**/login", async (route) => {
    if (route.request().method() === "POST") await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });

  const button = page.locator('button[type="submit"]');
  const before = await button.boundingBox();
  await button.click();
  await expect(button.getByRole("status", { name: "Working" })).toBeVisible();
  await expect(button).toBeDisabled(); // so it can't be clicked twice
  expect(await button.boundingBox()).toEqual(before);
  await expect(page).toHaveURL(/\/broker/);
});

test("the demo scenario button sets up the reviewers' starting point in one click", async ({ browser }) => {
  const broker = await signIn(browser, "broker@demo.test");
  await broker.getByRole("button", { name: "Load demo scenario" }).click();

  // Lands on a paid policy with Cyber on it, labelled as demo data.
  await expect(broker).toHaveURL(/\/broker\/policies\//, { timeout: 60_000 });
  await expect(balance(broker)).toHaveText("$0.00");
  await expect(broker.getByTestId("demo-notice")).toContainText("wasn't signed through DocuSign");
  await expect(broker.locator("#statement").getByText("Payment received (card ending 4242)")).toHaveCount(2);

  // The correction the reviewers will make: Cyber began a week earlier than recorded.
  await broker.locator("#history-2").getByRole("button", { name: "Correct this" }).click();
  const form = broker.getByTestId("correct-2");
  const date = form.locator('input[name="correctedDate"]');
  const recorded = await date.inputValue();
  const weekEarlier = new Date(Date.parse(`${recorded}T00:00:00Z`) - 7 * 86_400_000).toISOString().slice(0, 10);
  await date.fill(weekEarlier);
  await form.getByRole("button", { name: "Preview correction" }).click();
  await expect(form.getByTestId("preview-after")).toHaveText("$14.00");
  await form.getByRole("button", { name: "Confirm correction" }).click();
  await expect(balance(broker)).toHaveText("$14.00");
  await expect(broker.locator("#statement")).toContainText("Superseded by correction #3");
  if (process.env.SHOT) {
    await broker.setViewportSize({ width: 1200, height: 1500 });
    await broker.goto(broker.url().split("#")[0]);
    await broker.screenshot({ path: "docs/screenshots/demo-scenario-corrected.png" });
  }
});
