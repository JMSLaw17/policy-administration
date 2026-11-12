import "dotenv/config";
import { expect, test } from "@playwright/test";
import Stripe from "stripe";
import { balance, payByCard } from "../e2e/helpers";
import { freshPaidPolicy } from "./helpers";

/**
 * A payment that the customer's bank takes back after it has cleared, on a
 * deployed copy of the app, end to end through Stripe's webhook.
 *
 * It loads its own demo scenario, makes $14.00 due with the reviewers'
 * correction, and pays it with Stripe's test card that is disputed straight
 * after it succeeds. It then loses the dispute through Stripe's API (in test
 * mode, by submitting Stripe's "losing" evidence), which is how a returned
 * bank debit arrives too. Stripe tells the deployed app by webhook, and the
 * app has to put the $14.00 back on the statement as due.
 *
 *   npm run test:deployed -- returned-payment
 *
 * Needs the Stripe test key in `.env`, to lose the dispute. Against a local
 * server it stops after the dispute is lost, because Stripe's webhooks can't
 * reach a local machine.
 */

/** Succeeds, then is disputed by the cardholder as fraudulent. */
const CARD_DISPUTED = "4000 0000 0000 0259";

const key = process.env.STRIPE_SECRET_KEY ?? "";

test("a payment the bank takes back becomes due again, through Stripe's webhook", async ({ browser, baseURL }) => {
  test.skip(!key, "Needs STRIPE_SECRET_KEY in .env");
  // The same guard the app has: never anything but Stripe's test mode.
  expect(key.startsWith("sk_test_") || key.startsWith("rk_test_"), "a Stripe test-mode key").toBe(true);
  const stripe = new Stripe(key);
  const { broker, holder, policyId, policyNumber } = await freshPaidPolicy(browser);

  await test.step("the reviewers' correction makes $14.00 due", async () => {
    await broker.locator("#history-2").getByRole("button", { name: "Correct this" }).click();
    const form = broker.getByTestId("correct-2");
    const date = form.locator('input[name="correctedDate"]');
    const recorded = await date.inputValue();
    await date.fill(new Date(Date.parse(`${recorded}T00:00:00Z`) - 7 * 86_400_000).toISOString().slice(0, 10));
    await form.locator('input[name="correctionReason"]').fill("Coverage began a week earlier than recorded");
    await form.getByRole("button", { name: "Preview correction" }).click();
    await expect(form.getByTestId("preview-after")).toHaveText("$14.00");
    await form.getByRole("button", { name: "Confirm correction" }).click();
    await expect(balance(broker)).toHaveText("$14.00");
  });

  let intentId = "";
  await test.step("the policyholder pays it with a card that is then disputed", async () => {
    await holder.goto(`/portal/policies/${policyId}`);
    await payByCard(holder, CARD_DISPUTED);
    await expect(balance(holder)).toHaveText("$0.00");
    // The payment's Stripe reference is in the payments table. The newest is the $14.00.
    await broker.reload();
    const references = await broker.locator("#payments").getByText(/^pi_\w+$/).allInnerTexts();
    intentId = references.at(-1)!;
    expect(intentId).toMatch(/^pi_/);
  });

  await test.step("the dispute is lost at Stripe", async () => {
    const waitFor = async <T>(what: string, read: () => Promise<T | undefined>) => {
      for (let i = 0; i < 45; i++) {
        const found = await read();
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
      throw new Error(`Stripe didn't show ${what} within 90 seconds`);
    };
    const dispute = await waitFor("the dispute", async () => (await stripe.disputes.list({ payment_intent: intentId })).data[0]);
    expect(dispute.amount).toBe(1_400);
    // While the dispute is open the money may still come back, so the policy stays paid.
    await broker.reload();
    await expect(balance(broker)).toHaveText("$0.00");

    await stripe.disputes.update(dispute.id, { evidence: { uncategorized_text: "losing_evidence" } });
    await waitFor("the dispute as lost", async () =>
      (await stripe.disputes.retrieve(dispute.id)).status === "lost" ? true : undefined,
    );
    console.log(`Dispute ${dispute.id.slice(0, 12)} on ${policyNumber} was lost`);
  });

  const local = /localhost|127\.0\.0\.1/.test(baseURL ?? "");
  test.skip(local, "Stripe's webhooks can't reach a local server, so the rest only runs against the deployed site");

  await test.step("the app hears by webhook and the $14.00 is due again", async () => {
    await expect(async () => {
      await broker.reload();
      await expect(balance(broker)).toHaveText("$14.00", { timeout: 2_000 });
    }).toPass({ timeout: 90_000 });

    // The payment's line is still on the statement, with the return below it.
    const statement = broker.locator("#statement");
    await expect(statement.getByText("Payment received (card ending 0259)")).toBeVisible();
    await expect(statement.getByText(/^Payment returned by the bank \(/)).toBeVisible();
    await expect(statement).toContainText("Returned by the bank");
    await expect(broker.locator("#payments")).toContainText("Returned by the bank after it had cleared.");
    await expect(broker.getByTestId("statement-summary").getByTestId("summary-balance")).toHaveText("$14.00");

    // The policyholder is told why it is due, and can pay again.
    await holder.reload();
    await expect(balance(holder)).toHaveText("$14.00");
    await expect(holder.getByTestId("due-reasons")).toContainText("Payment returned by the bank");
    await expect(holder.getByRole("button", { name: "Pay $14.00 now" })).toBeVisible();
  });
  console.log(`The returned $14.00 payment on ${policyNumber} is due again`);
});
