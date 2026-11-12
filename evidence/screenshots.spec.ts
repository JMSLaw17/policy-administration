import { expect, test, type Page } from "@playwright/test";
import { balance, CARD_OK, payByCard, signIn } from "../e2e/helpers";

/**
 * Runs the reviewers' scenario on a deployed copy of the app and saves a
 * screenshot at each step, as evidence of the app and its two sandbox
 * integrations working together.
 */

const DIR = "docs/evidence/screenshots";
const shot = (page: Page, name: string) => page.screenshot({ path: `${DIR}/${name}.png`, fullPage: true });
const weekFrom = (date: string, weeks: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + weeks * 7 * 86_400_000).toISOString().slice(0, 10);

test("screenshots of the scenario, the payments, and the integrations", async ({ browser }) => {
  const broker = await signIn(browser, "broker@demo.test");

  // 1. The starting point: paid policy, Cyber added on the wrong date and paid.
  await broker.getByRole("button", { name: "Load demo scenario" }).click();
  await expect(broker).toHaveURL(/\/broker\/policies\//, { timeout: 90_000 });
  await expect(balance(broker)).toHaveText("$0.00");
  await shot(broker, "01-scenario-start-paid-policy");
  const policyUrl = broker.url().split("#")[0];
  const policyId = policyUrl.split("/broker/policies/")[1];

  // 2. The correction, previewed before anything is saved.
  await broker.locator("#history-2").getByRole("button", { name: "Correct this" }).click();
  let form = broker.getByTestId("correct-2");
  let date = form.locator('input[name="correctedDate"]');
  const recorded = await date.inputValue();
  await date.fill(weekFrom(recorded, -1));
  await form.locator('input[name="correctionReason"]').fill("Coverage began a week earlier than recorded");
  await form.getByRole("button", { name: "Preview correction" }).click();
  await expect(form.getByTestId("preview-after")).toHaveText("$14.00");
  await form.scrollIntoViewIfNeeded();
  await shot(broker, "02-correction-preview");

  // 3. After confirming: original charge, reversal, new charge, $14.00 due.
  await form.getByRole("button", { name: "Confirm correction" }).click();
  await expect(balance(broker)).toHaveText("$14.00");
  await broker.goto(policyUrl);
  await shot(broker, "03-broker-statement-after-correction");

  // 4. What the customer sees.
  await broker.getByRole("link", { name: /^← / }).click();
  const login = (await broker.getByText(/Policyholder login:/).innerText()).match(/[\w.-]+@[\w.-]+\.test/)![0];
  const holder = await signIn(browser, login);
  await holder.goto(`/portal/policies/${policyId}`);
  await expect(balance(holder)).toHaveText("$14.00");
  await shot(holder, "04-policyholder-statement-and-explanation");

  // 5. The customer pays the $14.00 through Stripe's card form.
  await payByCard(holder, CARD_OK);
  await expect(balance(holder)).toHaveText("$0.00");
  await shot(holder, "05-policyholder-paid");

  // 6. The date is corrected the other way, and the difference is refunded.
  await broker.goto(policyUrl);
  await broker.locator("#history-3").getByRole("button", { name: "Correct this" }).click();
  form = broker.getByTestId("correct-3");
  date = form.locator('input[name="correctedDate"]');
  await date.fill(weekFrom(recorded, 1));
  await form.locator('input[name="correctionReason"]').fill("Coverage began a week later than first recorded");
  await form.getByRole("button", { name: "Preview correction" }).click();
  await expect(form.getByTestId("preview")).toContainText("Credit to refund to the customer");
  await form.getByRole("button", { name: "Confirm correction" }).click();
  await expect(balance(broker)).toHaveText("$0.00");
  await expect(broker.locator("#payments").getByRole("row").filter({ hasText: "Refund of" }).first()).toContainText("Succeeded");
  await broker.goto(policyUrl);
  await shot(broker, "06-refund-after-second-correction");

  // 7. The app's own log of what it sent to Stripe and DocuSign and what came back.
  await broker.goto("/broker/integrations");
  await shot(broker, "07-integration-log");

  // 8. A policy issued from a DocuSign-signed application, if there is one.
  await broker.goto("/broker");
  const hrefs = await broker.locator('a[href^="/broker/policies/"]').evaluateAll((links) => links.map((a) => a.getAttribute("href")!));
  for (const href of hrefs) {
    await broker.goto(href);
    if (await broker.getByText("through DocuSign").count()) {
      await shot(broker, "08-policy-with-docusign-signature");
      break;
    }
  }
});
