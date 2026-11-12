import { expect, type Browser } from "@playwright/test";
import { balance, signIn } from "../e2e/helpers";

/** Shared steps for the checks that run against a deployed copy of the app. */

/** Loads a demo scenario as the broker and returns the policy's pages for both roles. */
export async function freshPaidPolicy(browser: Browser) {
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
