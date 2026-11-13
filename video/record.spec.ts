import { expect, test } from "@playwright/test";
import { balance, CARD_OK, fillCard, payButton } from "../e2e/helpers";
import { checkTools, click, Director, hold, prepareNarration, scrollTo, show, typeInto } from "./director";

/**
 * Records the submission video by following docs/video-script.md on a
 * deployed copy of the app. Run it with `npm run video`, which then puts the
 * finished video together (scripts/video-assemble.mjs). See docs/video.md.
 *
 * Like `npm run evidence:screenshots`, it CHANGES DATA: it loads one demo
 * scenario (a new customer, a policy and real Stripe test payments), corrects
 * it twice, and pays $14.00 by test card.
 *
 * VIDEO_PARTS=intro,issuing records only some parts (intro, issuing,
 * scenario, integrations, closing), for trying out a change quickly.
 */

/** The policy shown as signed through DocuSign in part 2. Skipped if it isn't on Acme's page. */
const SIGNED_POLICY = process.env.VIDEO_SIGNED_POLICY ?? "SBP-2026-0002";
const PARTS = process.env.VIDEO_PARTS?.split(",").map((p) => p.trim());
const part = (name: string) => !PARTS || PARTS.includes(name);

const weekFrom = (date: string, weeks: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + weeks * 7 * 86_400_000).toISOString().slice(0, 10);

test("record the submission video", async ({ browser }) => {
  checkTools();
  const lines = prepareNarration();
  for (const line of Object.values(lines)) console.log(`  ${line.id}: ${line.seconds.toFixed(1)}s (${line.source})`);

  const film = new Director(lines);
  const broker = await film.signIn(browser, "broker", "broker@demo.test");
  await broker.goto("/broker");
  film.start("broker");

  // 1. What this is
  if (part("intro")) {
    await film.beat("intro", () => show(broker, broker.getByRole("heading", { name: "Customers" })));
    await film.beat("intro-idea", () => show(broker, broker.getByRole("link", { name: "Acme Bakery LLC" })));
  }

  // 2. Issuing a policy, and one signed through DocuSign
  if (part("issuing")) {
    await film.beat("issue-form", async () => {
      await click(broker, broker.getByRole("link", { name: "Acme Bakery LLC" }));
      await broker.waitForURL(/\/broker\/customers\//);
      const form = broker.locator("section").filter({ has: broker.getByTestId("issue-total") });
      await scrollTo(broker, form);
      const cyber = form.locator('input[value="CYBER"]');
      await click(broker, cyber);
      await show(broker, form.getByTestId("issue-total"));
      await hold(broker, 1500);
      await click(broker, cyber);
      await show(broker, form.getByTestId("issue-total"));
    });
    const applications = broker.locator("section").filter({ has: broker.getByRole("heading", { name: "Applications" }) });
    if (await applications.count()) {
      await film.beat("issue-signing", () => show(broker, applications.getByRole("heading", { name: "Applications" })));
    }
    const signed = broker.getByRole("link", { name: SIGNED_POLICY, exact: true }).first();
    if (await signed.count()) {
      await film.beat("issue-signed", async () => {
        await click(broker, signed);
        await broker.waitForURL(/\/broker\/policies\//);
        await show(broker, broker.getByText(/through\s+DocuSign/).first());
        await show(broker, broker.getByRole("link", { name: "View signed application" }).first());
      });
    } else {
      console.warn(`  Skipped the signed policy: no link to ${SIGNED_POLICY} on Acme's page. Set VIDEO_SIGNED_POLICY.`);
    }
  }

  // 3. The scenario, and 4. a second correction with a refund
  if (part("scenario")) {
    await film.offscreen(() => broker.goto("/broker"));
    await film.beat("scenario-load", async () => {
      await click(broker, broker.getByRole("button", { name: "Load demo scenario" }));
    });
    await film.offscreen(async () => {
      await expect(broker).toHaveURL(/\/broker\/policies\//, { timeout: 90_000 });
      await expect(balance(broker)).toHaveText("$0.00");
    });
    const policyUrl = broker.url().split("#")[0];
    const policyId = policyUrl.split("/broker/policies/")[1];

    await film.beat("scenario-start", () => show(broker, broker.getByTestId("demo-notice")));
    await film.beat("scenario-statement", async () => {
      await scrollTo(broker, broker.locator("#statement"), "start");
      await show(broker, broker.getByTestId("summary-balance"));
    });
    await film.beat("scenario-calc", async () => {
      const cyberLine = broker.locator("#statement tr").filter({ hasText: "Cyber Liability: added from" }).first();
      await click(broker, cyberLine.getByText("How was this calculated?"));
      await show(broker, cyberLine);
    });

    // The correction: a week earlier
    const entry2 = broker.locator("#history-2");
    const form2 = broker.getByTestId("correct-2");
    let recorded = "";
    await film.beat("correct-form", async () => {
      await scrollTo(broker, entry2);
      await click(broker, entry2.getByRole("button", { name: "Correct this" }));
      const date = form2.locator('input[name="correctedDate"]');
      recorded = await date.inputValue();
      await click(broker, date);
      await date.fill(weekFrom(recorded, -1));
      await typeInto(broker, form2.locator('input[name="correctionReason"]'), "Coverage began a week earlier than recorded");
    });
    await film.beat("correct-preview", async () => {
      await click(broker, form2.getByRole("button", { name: "Preview correction" }));
      await expect(form2.getByTestId("preview-after")).toHaveText("$14.00");
      await scrollTo(broker, form2.getByTestId("preview"));
      await show(broker, form2.getByTestId("preview-after"));
    });
    await film.beat("correct-confirm", () => click(broker, form2.getByRole("button", { name: "Confirm correction" })));
    await film.offscreen(async () => {
      await expect(balance(broker)).toHaveText("$14.00");
      await broker.goto(policyUrl);
    });
    await film.beat("correct-statement", async () => {
      await scrollTo(broker, broker.locator("#statement"), "start");
      await show(broker, broker.locator("#statement").getByText(/Superseded by correction/).first());
    });
    await film.beat("correct-explained", () => show(broker, broker.locator("#history-3").getByTestId("explanation")));

    // The policyholder's side, and a live Stripe payment
    film.stop();
    await broker.getByRole("link", { name: /^← / }).first().click();
    const login = (await broker.getByText(/Policyholder login:/).innerText()).match(/[\w.-]+@[\w.-]+\.test/)![0];
    const holder = await film.signIn(browser, "holder", login);
    await holder.goto(`/portal/policies/${policyId}`);
    await expect(balance(holder)).toHaveText("$14.00");
    film.start("holder");
    await film.beat("holder-sees", async () => {
      await show(holder, balance(holder));
      await show(holder, holder.getByTestId("due-reasons"));
    });
    await film.beat("holder-pay", async () => {
      await click(holder, holder.getByRole("button", { name: /^Pay \$[\d,.]+ now$/ }));
      const stripeForm = holder.locator('iframe[title="Secure payment input frame"]:visible').first();
      await scrollTo(holder, stripeForm);
      await fillCard(holder, CARD_OK);
      await click(holder, payButton(holder));
    });
    await film.offscreen(() => expect(balance(holder)).toHaveText("$0.00", { timeout: 60_000 }));
    await film.beat("holder-paid", async () => {
      await scrollTo(holder, holder.locator("#payments"), "start");
      await show(holder, holder.locator("#payments").getByRole("row").filter({ hasText: "$14.00" }).first());
    });

    // A second correction, two weeks later, which refunds the difference
    film.stop();
    await broker.goto(policyUrl);
    film.start("broker");
    const entry3 = broker.locator("#history-3");
    const form3 = broker.getByTestId("correct-3");
    await film.beat("refund-form", async () => {
      await scrollTo(broker, entry3);
      await click(broker, entry3.getByRole("button", { name: "Correct this" }));
      const date = form3.locator('input[name="correctedDate"]');
      await click(broker, date);
      await date.fill(weekFrom(recorded, 1));
      await typeInto(broker, form3.locator('input[name="correctionReason"]'), "Coverage began a week later than first recorded");
    });
    await film.beat("refund-preview", async () => {
      await click(broker, form3.getByRole("button", { name: "Preview correction" }));
      const preview = form3.getByTestId("preview");
      await expect(preview).toContainText("Credit to refund to the customer");
      await scrollTo(broker, preview);
      await show(broker, preview.getByText("Credit to refund to the customer").first());
      await hold(broker, 2500);
      await click(broker, form3.getByRole("button", { name: "Confirm correction" }));
    });
    await film.offscreen(async () => {
      await expect(balance(broker)).toHaveText("$0.00");
      const refundRow = broker.locator("#payments").getByRole("row").filter({ hasText: "Refund of" }).first();
      await expect(refundRow).toContainText("Succeeded", { timeout: 60_000 });
      await broker.goto(policyUrl);
    });
    await film.beat("refund-done", async () => {
      await scrollTo(broker, broker.locator("#statement"), "start");
      await show(broker, broker.locator("#statement tr").filter({ hasText: "Refund" }).last());
      await show(broker, broker.locator("#payments").getByRole("row").filter({ hasText: "Refund of" }).first());
    });
  }

  // 5. The integrations
  if (part("integrations")) {
    await film.beat("integrations", async () => {
      await click(broker, broker.getByRole("link", { name: "Integration log" }));
      await broker.waitForURL(/\/broker\/integrations/);
      await show(broker, broker.getByRole("heading", { name: "Integration log" }));
      await hold(broker, 2500);
      await broker.mouse.wheel(0, 500);
    });
  }

  // 6. What's simulated and what's next
  if (part("closing")) {
    await film.beat("closing", async () => {
      await click(broker, broker.getByRole("link", { name: "Customers", exact: true }));
      await broker.waitForURL(/\/broker$/);
    });
    await hold(broker, 1500);
  }

  const timeline = await film.finish();
  const seconds = timeline.segments.reduce((sum, s) => sum + (s.to - s.from) / 1000, 0);
  console.log(`  Recorded ${timeline.beats.length} lines, ${Math.round(seconds)}s of film.`);
});
