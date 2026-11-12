import { expect, test, type Browser, type Page } from "@playwright/test";
import { balance, CARD_OK, payByCard, signIn } from "../e2e/helpers";

/**
 * A cancellation with its refund, and a renewal, on a deployed copy of the
 * app. Each test loads its own demo scenario (a new fictional customer with a
 * paid policy), so it never touches existing policies and can be run again.
 *
 *   npm run test:deployed -- cancel-and-renew
 */

const todayInNewYork = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());

/** Loads a demo scenario as the broker and returns the policy's pages for both roles. */
async function freshPaidPolicy(browser: Browser) {
  const broker = await signIn(browser, "broker@demo.test");
  await broker.getByRole("button", { name: "Load demo scenario" }).click();
  await expect(broker).toHaveURL(/\/broker\/policies\//, { timeout: 90_000 });
  await expect(balance(broker)).toHaveText("$0.00");
  const policyUrl = broker.url().split("#")[0];
  const policyNumber = await broker.getByRole("heading", { level: 1 }).innerText();

  // The demo customer's login is shown on their customer page.
  await broker.getByRole("link", { name: /^← / }).click();
  const login = (await broker.getByText(/Policyholder login:/).innerText()).match(/[\w.-]+@[\w.-]+\.test/)![0];
  await broker.goto(policyUrl);
  const holder = await signIn(browser, login);
  return { broker, holder, policyUrl, policyNumber, policyId: policyUrl.split("/broker/policies/")[1] };
}

const refundRows = (page: Page) => page.locator("#payments").getByRole("row").filter({ hasText: "Refund of" });

test("cancelling a paid policy credits the unused days and refunds them to the cards", async ({ browser }) => {
  const { broker, holder, policyId, policyNumber } = await freshPaidPolicy(browser);

  const card = broker.locator("#cancel");
  await card.locator('input[type="date"]').fill(todayInNewYork());
  await card.locator("input:not([type=date])").first().fill("Deployed check: customer closed the business");
  await card.getByRole("button", { name: "Preview cancellation" }).click();
  const preview = card.getByTestId("preview");
  await expect(preview).toContainText("General Liability: unused days after cancellation");
  await expect(preview).toContainText("Cyber Liability: unused days after cancellation");
  await expect(preview).toContainText("Credit to refund to the customer");
  const refund = await card.getByTestId("preview-after").innerText();
  await card.getByRole("button", { name: "Cancel the policy" }).click();

  // Cancelled, nothing owed either way, and the refund went out without another click.
  await expect(broker.getByText("Cancelled", { exact: true }).first()).toBeVisible();
  await expect(balance(broker)).toHaveText("$0.00");
  // More than the newest payment covers, so it is split across both, newest first.
  await expect(refundRows(broker)).toHaveCount(2);
  await expect(refundRows(broker).filter({ hasText: "Succeeded" })).toHaveCount(2);
  const amounts = await refundRows(broker).evaluateAll((rows) =>
    rows.map((r) => Number(r.lastElementChild!.textContent!.replace(/[$,]/g, ""))),
  );
  expect(amounts.reduce((a, b) => a + b, 0).toFixed(2)).toBe(refund.replace(/[$,]/g, ""));
  await expect(broker.locator("#statement")).toContainText("Refund sent to your original payment method");
  // A cancelled policy can't be changed or renewed.
  await expect(broker.locator("#edit-coverage")).toHaveCount(0);
  await expect(broker.locator("#renew")).toHaveCount(0);

  await holder.goto(`/portal/policies/${policyId}`);
  await expect(holder.getByText("Cancelled", { exact: true }).first()).toBeVisible();
  await expect(balance(holder)).toHaveText("$0.00");
  await expect(holder.locator("#statement")).toContainText("unused days after cancellation");
  await expect(refundRows(holder).filter({ hasText: "Succeeded" })).toHaveCount(2);
  console.log(`Cancelled ${policyNumber} and refunded ${refund}`);
});

test("renewing a policy creates a linked policy for the next term, due when it starts", async ({ browser }) => {
  const { broker, holder, policyUrl, policyNumber } = await freshPaidPolicy(browser);

  // The renewal carries both coverages forward at today's prices.
  const card = broker.locator("#renew");
  await expect(card).toContainText("General Liability");
  await expect(card).toContainText("Cyber Liability");
  const premium = await card.getByTestId("renewal-premium").innerText();
  await card.getByRole("button", { name: "Renew policy" }).click();

  await expect(broker).not.toHaveURL(policyUrl);
  await expect(broker.getByText(`Renewal of ${policyNumber}`)).toBeVisible();
  const renewalNumber = await broker.getByRole("heading", { level: 1 }).innerText();
  const renewalId = broker.url().split("/broker/policies/")[1].split(/[?#]/)[0];
  await expect(balance(broker)).toHaveText(premium);
  // The new term hasn't started, so the premium is due on its first day, not now.
  await expect(broker.getByTestId("due-date")).toContainText("when the term starts");
  await expect(broker.locator("#history-1")).toContainText("Policy renewed");

  // The expiring policy links forward, can't be renewed twice, and its own statement is unchanged.
  await broker.goto(policyUrl);
  await expect(broker.getByText(`Renewed for the following term as ${renewalNumber}`)).toBeVisible();
  await expect(broker.locator("#renew")).toHaveCount(0);
  await expect(balance(broker)).toHaveText("$0.00");

  // The policyholder sees both policies and can pay the renewal early.
  await holder.goto("/portal");
  await expect(holder.getByRole("link", { name: renewalNumber })).toBeVisible();
  await holder.goto(`/portal/policies/${renewalId}`);
  await expect(holder.getByText(`Renewal of ${policyNumber}`)).toBeVisible();
  await expect(holder.locator("#pay")).toContainText("You can pay early");
  await payByCard(holder, CARD_OK);
  await expect(balance(holder)).toHaveText("$0.00");

  // The broker's commission page lists the renewal as its own policy.
  await broker.goto("/broker/commissions");
  await expect(broker.getByRole("row").filter({ hasText: renewalNumber })).toContainText(premium);
  console.log(`Renewed ${policyNumber} as ${renewalNumber} for ${premium}, paid early`);
});
