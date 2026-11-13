import { expect, test, type Browser, type Page } from "@playwright/test";
import { DEMO_PASSWORD } from "../src/lib/demo";
import { balance, CARD_DECLINED, CARD_OK, fillCard, openPayForm, payButton, payByCard, signIn } from "./helpers";

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
    await form.locator('input[name="correctionReason"]').fill("Draft reason");
    await form.getByRole("button", { name: "Preview correction" }).click();
    // The reason is rewritten after the preview. The one on screen at confirmation is the one saved.
    await form.locator('input[name="correctionReason"]').fill("Coverage began a week earlier than recorded");
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
    await expect(broker.locator("#history-3")).toContainText("Reason: Coverage began a week earlier than recorded");
    await expect(broker.locator("#history")).not.toContainText("Draft reason");
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

/** Loads a demo scenario (a paid policy with Cyber on it) and signs in as its policyholder too. */
async function demoPolicy(browser: Browser) {
  const broker = await signIn(browser, "broker@demo.test");
  await broker.getByRole("button", { name: "Load demo scenario" }).click();
  await expect(broker).toHaveURL(/\/broker\/policies\//, { timeout: 60_000 });
  const policyUrl = broker.url().split("#")[0];
  await broker.getByRole("link", { name: /^← / }).click();
  const login = (await broker.getByText(/Policyholder login:/).innerText()).match(/[\w.-]+@[\w.-]+\.test/)![0];
  await broker.goto(policyUrl);
  const holder = await signIn(browser, login);
  await holder.goto(policyUrl.replace("/broker/", "/portal/"));
  return { broker, holder };
}

/** Moves the start of Cyber by a number of days, correcting the latest version of that change. */
async function moveCyber(broker: Page, days: number) {
  await broker.reload();
  await broker.locator("#history").getByRole("button", { name: "Correct this" }).last().click();
  const form = broker.locator('[data-testid^="correct-"]');
  const date = form.locator('input[name="correctedDate"]');
  const recorded = await date.inputValue();
  await date.fill(new Date(Date.parse(`${recorded}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10));
  await form.getByRole("button", { name: "Preview correction" }).click();
  await form.getByRole("button", { name: "Confirm correction" }).click();
}

test("the Pay button shows what Stripe will collect, and asks again when the amount changed", async ({ browser }) => {
  const { broker, holder } = await demoPolicy(browser);

  // Cyber began a week earlier: $14.00 is due, and the policyholder has the page open.
  await moveCyber(broker, -7);
  await expect(balance(broker)).toHaveText("$14.00");
  await holder.reload();
  await expect(holder.getByRole("button", { name: "Pay $14.00 now" })).toBeVisible();

  // Before they pay, the broker moves it another week earlier. The open page still says $14.00.
  await moveCyber(broker, -7);
  await expect(balance(broker)).toHaveText("$28.00");
  await openPayForm(holder);

  // The form shows the amount Stripe holds, says it changed, and won't take payment until they agree.
  const changed = holder.getByTestId("amount-changed");
  await expect(changed).toContainText("It was $14.00 and is now $28.00");
  await expect(payButton(holder)).toHaveText("Pay $28.00");
  await expect(payButton(holder)).toBeDisabled();
  // The explanation beside it lists both corrections, and they come to the amount on the button.
  const why = holder.getByTestId("due-reasons");
  await expect(why.getByRole("listitem")).toHaveCount(2);
  await expect(why.getByTestId("due-total")).toContainText("$28.00");
  await fillCard(holder, CARD_OK);
  await changed.getByRole("checkbox").check();
  await expect(payButton(holder)).toBeEnabled();

  // With the form still open, the broker moves it back a week. Stripe now holds $14.00, not the $28.00 on the button.
  await moveCyber(broker, 7);
  await expect(balance(broker)).toHaveText("$14.00");
  await payButton(holder).click();
  // Nothing is charged. The button catches up, and asks again.
  await expect(changed).toContainText("It was $28.00 and is now $14.00");
  await expect(payButton(holder)).toHaveText("Pay $14.00");
  await expect(payButton(holder)).toBeDisabled();
  await changed.getByRole("checkbox").check();
  await payButton(holder).click();

  await expect(balance(holder)).toHaveText("$0.00");
  // One payment of $14.00 was taken, on top of the scenario's two.
  await expect(holder.locator("#statement").getByText("Payment received (card ending 4242)")).toHaveCount(3);
  await expect(holder.getByTestId("statement-summary").getByTestId("summary-refunds")).toHaveText("$0.00");
});

test("a broker's confirmation is refused when a payment landed after the preview", async ({ browser }) => {
  const { broker, holder } = await demoPolicy(browser);
  await moveCyber(broker, -7);
  await expect(balance(broker)).toHaveText("$14.00");

  // The broker previews a cancellation while $14.00 is unpaid.
  await broker.reload();
  const card = broker.locator("#cancel");
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
  await card.locator('input[type="date"]').fill(today);
  await card.locator("input:not([type=date])").first().fill("Customer closed the business");
  await card.getByRole("button", { name: "Preview cancellation" }).click();
  const refundBefore = await card.getByTestId("preview-after").innerText();

  // The policyholder pays the $14.00 before the broker confirms.
  await holder.reload();
  await payByCard(holder, CARD_OK);
  await expect(balance(holder)).toHaveText("$0.00");

  // Confirming saves nothing: the refund would now be $14.00 larger than the one previewed.
  await card.getByRole("button", { name: "Cancel the policy" }).click();
  await expect(card.getByTestId("preview-changed")).toContainText("Not saved.");
  const dollars = (text: string) => Number(text.replace(/[$,]/g, ""));
  await expect
    .poll(async () => dollars(await card.getByTestId("preview-after").innerText()))
    .toBeCloseTo(dollars(refundBefore) + 14, 2);
  await expect(broker.getByText("Active", { exact: true }).first()).toBeVisible();

  // Confirming the new figures cancels the policy and refunds them.
  await card.getByRole("button", { name: "Cancel the policy" }).click();
  await expect(broker.getByText("Cancelled", { exact: true }).first()).toBeVisible();
  await expect(balance(broker)).toHaveText("$0.00");
});

test("a renewal is refused if the policy changed after the renewal was shown", async ({ browser }) => {
  const { broker } = await demoPolicy(browser);
  const renew = broker.locator("#renew");
  await expect(renew.getByTestId("renewal-premium")).toHaveText("$1,825.00");

  // In another tab, Business Property is added to the policy. This tab still shows the old renewal.
  const otherTab = await broker.context().newPage();
  await otherTab.goto(broker.url());
  const edit = otherTab.locator("#edit-coverage");
  await edit.locator('input[name="effectiveDate"]').fill(new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date()));
  await edit.locator('input[value="PROP"]').check();
  await edit.getByRole("button", { name: "Preview change" }).click();
  await edit.getByRole("button", { name: "Confirm coverage change" }).click();
  await expect(otherTab.getByTestId("saved-notice")).toBeVisible();

  // Renewing from the stale tab creates nothing, says why, and shows the renewal as it would be now.
  await renew.getByRole("button", { name: "Renew policy" }).click();
  await expect(renew.getByTestId("renew-error")).toContainText("has changed since the renewal was shown");
  await expect(renew.getByTestId("renewal-premium")).toHaveText("$2,190.00");
  await expect(broker).toHaveURL(otherTab.url());

  // Renewing again, with the new terms on screen, goes through.
  await renew.getByRole("button", { name: "Renew policy" }).click();
  await expect(broker).not.toHaveURL(otherTab.url());
  await expect(balance(broker)).toHaveText("$2,190.00");
});

test("a preview is thrown away if the date was changed while it was loading", async ({ browser }) => {
  const { broker } = await demoPolicy(browser);
  await broker.locator("#history-2").getByRole("button", { name: "Correct this" }).click();
  const form = broker.getByTestId("correct-2");
  const date = form.locator('input[name="correctedDate"]');
  const recorded = await date.inputValue();
  const earlier = (days: number) => new Date(Date.parse(`${recorded}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);

  // Hold the preview back, so there is time to change the date while it loads.
  await broker.route("**/broker/policies/**", async (route) => {
    if (route.request().method() === "POST") await new Promise((resolve) => setTimeout(resolve, 1_500));
    await route.continue();
  });
  await date.fill(earlier(7));
  await form.getByRole("button", { name: "Preview correction" }).click();
  await date.fill(earlier(14));

  // The answer for a week earlier arrives, but the field now says two weeks. It isn't shown,
  // so there is nothing to confirm that doesn't match the field.
  await expect(form.getByRole("button", { name: "Preview correction" })).toBeEnabled();
  await expect(form.getByTestId("preview")).toHaveCount(0);
  await broker.unroute("**/broker/policies/**");

  // Previewing again shows the figures for the date on screen, and that is what is saved.
  await form.getByRole("button", { name: "Preview correction" }).click();
  await expect(form.getByTestId("preview-after")).toHaveText("$28.00");
  await form.getByRole("button", { name: "Confirm correction" }).click();
  await expect(balance(broker)).toHaveText("$28.00");
  await expect(broker.locator("#history-3")).toContainText("Cyber Liability now counts 14 more days");
});

test("a refused confirmation isn't shown if the form changed while it was in flight", async ({ browser }) => {
  const { broker, holder } = await demoPolicy(browser);
  await moveCyber(broker, -7);
  await expect(balance(broker)).toHaveText("$14.00");

  // The broker previews moving Cyber a second week earlier, while $14.00 is unpaid.
  await broker.reload();
  await broker.locator("#history").getByRole("button", { name: "Correct this" }).last().click();
  const form = broker.locator('[data-testid^="correct-"]');
  const date = form.locator('input[name="correctedDate"]');
  const recorded = await date.inputValue();
  const earlier = (days: number) => new Date(Date.parse(`${recorded}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
  await date.fill(earlier(7));
  await form.getByRole("button", { name: "Preview correction" }).click();
  await expect(form.getByTestId("preview-after")).toHaveText("$28.00");

  // The policyholder pays the $14.00, so the figures in that preview are out of date
  // and the server will refuse to save it.
  await holder.reload();
  await payByCard(holder, CARD_OK);
  await expect(balance(holder)).toHaveText("$0.00");

  // The broker confirms, and changes the date again while the confirmation is in flight.
  await broker.route("**/broker/policies/**", async (route) => {
    if (route.request().method() === "POST") await new Promise((resolve) => setTimeout(resolve, 1_500));
    await route.continue();
  });
  await form.getByRole("button", { name: "Confirm correction" }).click();
  await date.fill(earlier(14));

  // The refusal comes back with new figures for the first date. They aren't shown beside the
  // second date. The form is left ready to preview what it shows now.
  await expect(form.getByRole("button", { name: "Preview correction" })).toBeEnabled();
  await expect(form.getByTestId("preview")).toHaveCount(0);
  await broker.unroute("**/broker/policies/**");
  await expect(balance(broker)).toHaveText("$0.00"); // nothing was saved, and the payment shows

  // Previewing and confirming the date on screen works, and that date is what is saved.
  await form.getByRole("button", { name: "Preview correction" }).click();
  await expect(form.getByTestId("preview-after")).toHaveText("$28.00");
  await form.getByRole("button", { name: "Confirm correction" }).click();
  await expect(balance(broker)).toHaveText("$28.00");
  await expect(broker.locator("#history-4")).toContainText("Cyber Liability now counts 14 more days");
});

