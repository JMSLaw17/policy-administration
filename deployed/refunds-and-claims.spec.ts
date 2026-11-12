import { expect, test, type Page } from "@playwright/test";
import { balance, CARD_DECLINED, CARD_OK, payByCard, signIn } from "../e2e/helpers";

/**
 * Refunds and claims on a deployed copy of the app, on an existing active
 * policy (the deployed app needs a DocuSign signature to issue a new one).
 *
 * Refund: make sure the policy is paid (trying a declined card first if
 * anything is due), add Cyber if it isn't on the policy
 * yet, pay for it, then correct Cyber's start date to a week later. The
 * customer has then paid for 7 days they don't get, and the app must refund
 * that to the card through Stripe on its own.
 *
 * Claims: the policyholder files two claims. The broker approves and pays
 * one, and denies the other with a reason.
 *
 * It can be run again: each run moves Cyber's start date another week later
 * and files two more claims.
 */

const POLICY = process.env.POLICY ?? "SBP-2026-0002";

const todayInNewYork = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

const section = (page: Page, heading: string) =>
  page.locator("section").filter({ has: page.getByRole("heading", { name: heading, exact: true }) });

async function payIfDue(holder: Page, { declineFirst = false } = {}) {
  await holder.reload();
  const due = await balance(holder).innerText();
  if (due === "$0.00") return;
  if (declineFirst) {
    // A declined card first: it must be shown as failed and leave the amount due unchanged.
    await payByCard(holder, CARD_DECLINED);
    await expect(holder.getByTestId("payment-error")).toContainText(/declined/i);
    await holder.reload();
    await expect(balance(holder)).toHaveText(due);
    await expect(holder.locator("#payments").getByRole("row").filter({ hasText: "Failed" }).first()).toBeVisible();
  }
  await payByCard(holder, CARD_OK);
  await expect(balance(holder)).toHaveText("$0.00");
}

test(`refunds and claims on ${POLICY}`, async ({ browser }) => {
  const broker = await signIn(browser, "broker@demo.test");

  // Find the policy from the broker's home page.
  await broker.goto("/broker");
  const href = await broker.getByRole("link", { name: POLICY, exact: false }).first().getAttribute("href");
  expect(href, `policy ${POLICY} on the broker's home page`).toBeTruthy();
  const policyId = href!.split("/broker/policies/")[1];
  await broker.goto(href!);
  // Sign in as whoever holds this policy. Their login is shown on the customer's page.
  await broker.getByRole("link", { name: /^← / }).click();
  const login = (await broker.getByText(/Policyholder login:/).innerText()).match(/[\w.-]+@[\w.-]+\.test/)![0];
  await broker.goto(href!);
  const holder = await signIn(browser, login);
  await holder.goto(`/portal/policies/${policyId}`);
  await expect(broker.getByText("Active", { exact: true }).first()).toBeVisible();

  await test.step("the policy is paid up, after a declined card if anything is due", async () => {
    await payIfDue(holder, { declineFirst: true });
  });

  await test.step("Cyber is on the policy and paid for", async () => {
    await broker.reload();
    if (!(await section(broker, "Coverage").innerText()).includes("Cyber Liability")) {
      const card = broker.locator("#edit-coverage");
      await card.locator('input[name="effectiveDate"]').fill(todayInNewYork());
      await card.locator('input[value="CYBER"]').check();
      await card.getByRole("button", { name: "Preview change" }).click();
      await expect(card.getByTestId("preview")).toContainText("Cyber Liability: added from");
      await card.getByRole("button", { name: "Confirm coverage change" }).click();
      await expect(section(broker, "Coverage")).toContainText("Cyber Liability");
    }
    await payIfDue(holder);
  });

  let refundText = "";
  await test.step("a correction that lowers the premium refunds the difference to the card", async () => {
    await broker.reload();
    const refundsBefore = await broker.locator("#payments").getByRole("row").filter({ hasText: "Refund of" }).count();

    // The last correctable entry in the history is the Cyber change (or its latest correction).
    await broker.locator("#history").getByRole("button", { name: "Correct this" }).last().click();
    const form = broker.locator('[data-testid^="correct-"]');
    const date = form.locator('input[name="correctedDate"]');
    await date.fill(addDays(await date.inputValue(), 7));
    await form.locator('input[name="correctionReason"]').fill("Coverage began a week later than recorded");
    await form.getByRole("button", { name: "Preview correction" }).click();
    await expect(form.getByTestId("preview")).toContainText("Credit to refund to the customer");
    refundText = await form.getByTestId("preview-after").innerText();
    expect(refundText).toMatch(/^\$\d/);
    await form.getByRole("button", { name: "Confirm correction" }).click();

    // The refund is sent without the broker doing anything more.
    await expect(balance(broker)).toHaveText("$0.00");
    const refunds = broker.locator("#payments").getByRole("row").filter({ hasText: "Refund of" });
    await expect(refunds).toHaveCount(refundsBefore + 1);
    await expect(refunds.last()).toContainText("Succeeded");
    await expect(refunds.last()).toContainText(refundText);
    await expect(broker.locator("#statement")).toContainText("Refund sent to your original payment method");

    await holder.reload();
    await expect(balance(holder)).toHaveText("$0.00");
    await expect(holder.locator("#statement")).toContainText("Refund sent to your original payment method");
  });
  console.log(`Refunded ${refundText} on ${POLICY}`);

  await test.step("the correction claws back the commission on the reversed charge", async () => {
    // The commission table follows the statement line by line. The reversal carries negative
    // commission of exactly the size the original charge earned.
    await broker.reload();
    const lines = await broker.locator("#commission tbody tr").evaluateAll((rows) =>
      rows.map((r) => [...r.querySelectorAll("td")].map((td) => td.textContent ?? "")),
    );
    const amount = (text: string) => Number(text.replace(/[$,+]/g, ""));
    const reversal = lines.filter((l) => l[1].startsWith("Reversal:")).at(-1)!;
    const original = lines.find((l) => `Reversal: ${l[1]}` === reversal[1])!;
    expect(amount(reversal[3])).toBeLessThan(0);
    expect(amount(reversal[3]) + amount(original[3])).toBe(0);
    // And the total is still 10% of the net premium.
    const totals = await broker.locator("#commission tfoot td").allInnerTexts();
    expect(amount(totals.at(-1)!)).toBeCloseTo(amount(totals.at(-2)!) * 0.1, 2);
  });

  const fileClaim = async (amount: string, description: string) => {
    await holder.reload();
    const claims = holder.locator("#claims");
    await claims.getByRole("button", { name: "File a claim" }).click();
    await claims.locator('select[name="coverageCode"]').selectOption("GL");
    await claims.locator('input[name="lossDate"]').fill(todayInNewYork());
    await claims.locator('input[name="claimed"]').fill(amount);
    await claims.locator('textarea[name="description"]').fill(description);
    await claims.getByRole("button", { name: "File claim" }).click();
    const saved = claims.getByText(/Claim CLM-\d{4}-\d+ filed/);
    await expect(saved).toBeVisible();
    const number = (await saved.innerText()).match(/CLM-\d{4}-\d+/)![0];
    await expect(claims.locator(`#claim-${number}`)).toContainText("Under review");
    return number;
  };

  let approved = "";
  let denied = "";
  await test.step("the policyholder files a claim, and the broker approves and pays it", async () => {
    approved = await fileClaim("4,000", "A customer slipped on a wet floor and was injured.");
    await broker.reload();
    const claim = broker.locator(`#claim-${approved}`);
    await claim.locator('input[name="approved"]').fill("3500");
    await claim.getByRole("button", { name: "Approve" }).click();
    // $3,500.00 approved loss less the $500.00 deductible.
    await claim.getByRole("button", { name: "Record payment of $3,000.00" }).click();
    await expect(claim).toContainText("Paid");
    await expect(claim).toContainText("$3,500.00 approved loss − $500.00 deductible = $3,000.00");
  });

  await test.step("the policyholder files another, and the broker denies it with a reason", async () => {
    denied = await fileClaim("900", "A delivery driver dropped and broke their own phone on our premises.");
    await broker.reload();
    const claim = broker.locator(`#claim-${denied}`);
    await claim.getByRole("button", { name: "Deny" }).click();
    await expect(claim.getByRole("alert")).toContainText("Give the reason");
    await claim.locator('input[name="note"]').fill("The business is not liable for damage a visitor causes to their own property.");
    await claim.getByRole("button", { name: "Deny" }).click();
    await expect(claim).toContainText("Denied");
  });

  await test.step("the policyholder sees both outcomes, and the premium statement is untouched", async () => {
    await holder.reload();
    await expect(holder.locator(`#claim-${approved}`)).toContainText("Paid");
    await expect(holder.locator(`#claim-${approved}`)).toContainText("$3,000.00");
    await expect(holder.locator(`#claim-${denied}`)).toContainText("Denied");
    await expect(holder.locator(`#claim-${denied}`)).toContainText("not liable for damage a visitor causes");
    await expect(holder.locator(`#claim-${approved}`).getByRole("button")).toHaveCount(0);
    await expect(balance(holder)).toHaveText("$0.00");
  });
  console.log(`Claims ${approved} (paid) and ${denied} (denied) on ${POLICY}`);
});
