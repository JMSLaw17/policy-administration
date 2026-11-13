import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { formatUSD, formulaFor, PolicyRuleError, proRate, todayISO } from "@/lib/engine";
import { claimsForPolicy, decideClaim, fileClaim, payClaim } from "@/lib/policies/claims";
import { commissionForPolicy } from "@/lib/policies/commissions";
import { updateCustomerDetails } from "@/lib/policies/details";
import { previewRenewal, renewPolicy } from "@/lib/policies/renewals";
import { issueFromApplication } from "@/lib/policies/applications";
import { applyChange, issuePolicy, PreviewChangedError, previewChange } from "@/lib/policies/service";
import { loadPolicyView } from "@/lib/policies/view";

/**
 * End-to-end tests of the policy workflow against a real (test) database.
 * Stripe and DocuSign aren't involved: payments are posted straight to the
 * ledger the way a confirmed Stripe payment would be.
 */

let brokerId: string;
let customerId: string;

beforeAll(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE "Claim", "Application", "IntegrationEvent", "LedgerEntry", "Refund", "Payment", "PolicyTransaction", "Policy", "User", "Customer" RESTART IDENTITY CASCADE',
  );
  const customer = await db.customer.create({
    data: {
      businessName: "Test Bakery LLC",
      contactName: "Tess Tester",
      email: "tess@test-bakery.test",
      addressLine1: "1 Test Street",
      city: "Springfield",
      state: "IL",
      postalCode: "62701",
    },
  });
  customerId = customer.id;
  const broker = await db.user.create({
    data: { email: "broker@test.test", name: "Test Broker", role: "BROKER", passwordHash: "x" },
  });
  brokerId = broker.id;
});

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE "Claim", "LedgerEntry", "Refund", "Payment", "PolicyTransaction", "Policy" RESTART IDENTITY CASCADE',
  );
});

const issue = (coverageCodes = ["GL"], startDate = "2026-10-01") =>
  issuePolicy({ customerId, startDate, coverageCodes, userId: brokerId });

const addCyber = (policyId: string, effectiveDate: string) =>
  applyChange(policyId, { kind: "COVERAGE_CHANGE", effectiveDate, add: ["CYBER"], remove: [] }, brokerId);

/** Records a payment for the whole amount due, as a confirmed Stripe payment would. */
async function payInFull(policyId: string) {
  const view = (await loadPolicyView(policyId))!;
  const payment = await db.payment.create({
    data: { policyId, amountCents: view.balanceCents, status: "SUCCEEDED" },
  });
  await db.ledgerEntry.create({
    data: {
      policyId,
      kind: "PAYMENT",
      amountCents: -view.balanceCents,
      description: "Payment received (test)",
      paymentId: payment.id,
    },
  });
}

const statement = async (policyId: string) =>
  (await loadPolicyView(policyId))!.statement.map((r) => [r.kind, r.amountCents, r.balanceAfterCents]);

describe("the scenario reviewers will test", () => {
  it("corrects the effective date, keeps the original charge visible, and shows $14.00 due", async () => {
    const policy = await issue();
    await payInFull(policy.id);
    const change = await addCyber(policy.id, "2026-11-01");
    await payInFull(policy.id);

    // Three weeks later: Cyber actually began a week earlier.
    const request = {
      kind: "CORRECTION" as const,
      transactionId: change.transaction.id,
      event: { type: "COVERAGE_CHANGE" as const, effectiveDate: "2026-10-25", add: ["CYBER"], remove: [] },
      reason: "Coverage began a week earlier than recorded",
    };
    const preview = await previewChange(policy.id, request);
    expect(preview).toMatchObject({ netChangeCents: 1_400, balanceBeforeCents: 0, balanceAfterCents: 1_400 });
    await applyChange(policy.id, request, brokerId);

    expect(await statement(policy.id)).toEqual([
      ["CHARGE", 109_500, 109_500],
      ["PAYMENT", -109_500, 0],
      ["CHARGE", 66_800, 66_800], // the original charge, still there
      ["PAYMENT", -66_800, 0],
      ["REVERSAL", -66_800, -66_800],
      ["CHARGE", 68_200, 1_400],
    ]);

    const view = (await loadPolicyView(policy.id))!;
    expect(view.balanceCents).toBe(1_400);
    expect(view.statement[2]).toMatchObject({ reversedByLine: 5, reversedBySeq: 3 });
    expect(view.statement[4]).toMatchObject({ reversesLine: 3 });
    expect(view.coverage.find((c) => c.code === "CYBER")).toMatchObject({ from: "2026-10-25" });

    const correction = view.history.find((h) => h.type === "CORRECTION")!;
    expect(correction.netCents).toBe(1_400);
    expect(correction.explanation).toBe(
      "Cyber Liability now counts 7 more days (341 instead of 334) at $2.00 a day, so its charge changes from $668.00 to $682.00. In total, $14.00 more is owed.",
    );
    expect(view.history.find((h) => h.seq === 2)!.supersededBySeq).toBe(3);

    // The policyholder is told why $14.00 is due, beside the Pay button: the correction alone,
    // since everything before it has been paid.
    expect(view.dueBecause).toMatchObject([
      {
        seq: 3,
        title: "Correction to #2",
        netCents: 1_400,
        reason: "Coverage began a week earlier than recorded",
        text:
          "Effective date corrected from Nov 1, 2026 to Oct 25, 2026. " +
          "Cyber Liability now counts 7 more days (341 instead of 334) at $2.00 a day, so its charge changes from $668.00 to $682.00. In total, $14.00 more is owed.",
      },
    ]);
    // And the statement adds up: premium − payments + refunds = amount due.
    expect(view.totals).toEqual({ premiumCents: 177_700, paidCents: 176_300, refundedCents: 0 });
    expect(view.totals.premiumCents - view.totals.paidCents + view.totals.refundedCents).toBe(view.balanceCents);

    // Once it is paid, there is nothing to explain.
    await payInFull(policy.id);
    expect((await loadPolicyView(policy.id))!.dueBecause).toEqual([]);
  });

  it("explains an unpaid amount by every change it comes from, oldest first", async () => {
    const policy = await issue();
    expect((await loadPolicyView(policy.id))!.dueBecause).toMatchObject([
      { seq: 1, title: "Policy issued", netCents: 109_500, text: "General Liability for Oct 1, 2026 to Oct 1, 2027." },
    ]);
    await payInFull(policy.id);

    // Cyber is added and then corrected to start a week later, before the customer pays for either.
    const change = await addCyber(policy.id, "2026-10-25");
    await applyChange(
      policy.id,
      {
        kind: "CORRECTION",
        transactionId: change.transaction.id,
        event: { type: "COVERAGE_CHANGE", effectiveDate: "2026-11-01", add: ["CYBER"], remove: [] },
      },
      brokerId,
    );
    const view = (await loadPolicyView(policy.id))!;
    expect(view.balanceCents).toBe(66_800);
    // Both changes are listed, and together they come to what is due. The paid-for issue isn't.
    expect(view.dueBecause.map((r) => [r.seq, r.title, r.netCents])).toEqual([
      [2, "Coverage changed", 68_200],
      [3, "Correction to #2", -1_400],
    ]);
  });

  it("handles the date being changed again, and to a later date", async () => {
    const policy = await issue();
    const change = await addCyber(policy.id, "2026-11-01");
    const correct = (effectiveDate: string) =>
      applyChange(
        policy.id,
        {
          kind: "CORRECTION",
          // Always pointing at the original action: the latest version is found automatically.
          transactionId: change.transaction.id,
          event: { type: "COVERAGE_CHANGE", effectiveDate, add: ["CYBER"], remove: [] },
        },
        brokerId,
      );

    expect((await correct("2026-10-25")).preview.netChangeCents).toBe(1_400);
    expect((await correct("2026-11-08")).preview.netChangeCents).toBe(-2_800);
    expect((await loadPolicyView(policy.id))!.balanceCents).toBe(109_500 + 65_400);
    await expect(correct("2026-11-08")).rejects.toThrow(/doesn't change anything/);
  });

  it("refuses a correction that would break a later change, and saves nothing", async () => {
    const policy = await issue();
    const change = await addCyber(policy.id, "2026-11-01");
    await applyChange(
      policy.id,
      { kind: "COVERAGE_CHANGE", effectiveDate: "2027-02-01", add: [], remove: ["CYBER"] },
      brokerId,
    );
    const before = await statement(policy.id);
    await expect(
      applyChange(
        policy.id,
        {
          kind: "CORRECTION",
          transactionId: change.transaction.id,
          event: { type: "COVERAGE_CHANGE", effectiveDate: "2027-03-01", add: ["CYBER"], remove: [] },
        },
        brokerId,
      ),
    ).rejects.toThrow(/conflicts with a later change \(#3\)/);
    expect(await statement(policy.id)).toEqual(before);
  });
});

describe("policy numbers", () => {
  it("are never repeated, even for policies issued at the same moment", async () => {
    const policies = await Promise.all(Array.from({ length: 8 }, () => issue()));
    const numbers = policies.map((p) => p.policyNumber).sort();
    expect(new Set(numbers).size).toBe(8);
    expect(numbers[0]).toBe("SBP-2026-0001");
    expect(numbers[7]).toBe("SBP-2026-0008");
  });
});

describe("cancellation", () => {
  it("credits unused days and leaves a credit to refund", async () => {
    const policy = await issue();
    await addCyber(policy.id, "2026-10-25");
    await payInFull(policy.id);
    const { preview } = await applyChange(policy.id, { kind: "CANCELLATION", effectiveDate: "2027-04-01" }, brokerId);
    expect(preview.netChangeCents).toBe(-91_500);

    const view = (await loadPolicyView(policy.id))!;
    expect(view).toMatchObject({ status: "CANCELLED", cancelledEffective: "2027-04-01", balanceCents: -91_500 });
    await expect(addCyber(policy.id, "2027-05-01")).rejects.toThrow(PolicyRuleError);
  });
});

describe("customer details", () => {
  it("records what changed in the policy history without touching the statement", async () => {
    const policy = await issue();
    const before = await statement(policy.id);
    await updateCustomerDetails(
      customerId,
      {
        businessName: "Test Bakery LLC",
        contactName: "Tess Tester",
        email: "tess@test-bakery.test",
        addressLine1: "2 Test Street",
        city: "Springfield",
        state: "IL",
        postalCode: "62701",
      },
      brokerId,
    );
    const view = (await loadPolicyView(policy.id))!;
    expect(view.history.at(-1)).toMatchObject({
      type: "DETAILS_CHANGE",
      summary: 'Street address changed from "1 Test Street" to "2 Test Street".',
    });
    expect(await statement(policy.id)).toEqual(before);
    // Extra fields from a caller are ignored rather than written.
    const sloppy = { ...view.customer, addressLine1: "1 Test Street", city: "Springfield", state: "IL", postalCode: "62701" };
    expect((await updateCustomerDetails(customerId, sloppy, brokerId)).changed).toBe(1);
  });
});

describe("broker commission", () => {
  it("earns 10% of each premium line and claws it back on reversals and credits", async () => {
    const policy = await issue();
    const change = await addCyber(policy.id, "2026-11-01");
    await payInFull(policy.id);
    await applyChange(
      policy.id,
      {
        kind: "CORRECTION",
        transactionId: change.transaction.id,
        event: { type: "COVERAGE_CHANGE", effectiveDate: "2026-10-25", add: ["CYBER"], remove: [] },
      },
      brokerId,
    );

    const commission = (await commissionForPolicy(policy.id))!;
    expect(commission.rateBps).toBe(1000);
    // The payment (statement line 3) earns nothing and isn't listed.
    expect(commission.lines.map((l) => [l.statementLine, l.kind, l.premiumCents, l.commissionCents])).toEqual([
      [1, "CHARGE", 109_500, 10_950],
      [2, "CHARGE", 66_800, 6_680],
      [4, "REVERSAL", -66_800, -6_680],
      [5, "CHARGE", 68_200, 6_820],
    ]);
    expect(commission.premiumCents).toBe(177_700);
    expect(commission.commissionCents).toBe(17_770);
    // Each line carries the date it was posted, and the policy carries the term it belongs to.
    const statement = (await loadPolicyView(policy.id))!.statement;
    for (const line of commission.lines) expect(line.postedAt).toBe(statement[line.statementLine - 1].postedAt);
    expect(commission).toMatchObject({ startDate: "2026-10-01", endDate: "2027-10-01", cancelledEffective: null });

    await applyChange(policy.id, { kind: "CANCELLATION", effectiveDate: "2027-04-01" }, brokerId);
    const after = (await commissionForPolicy(policy.id))!;
    expect(after.premiumCents).toBe(177_700 - 91_500);
    expect(after.commissionCents).toBe(17_770 - 9_150);
    expect(after.cancelledEffective).toBe("2027-04-01");
  });
});

describe("renewals", () => {
  it("renews the coverage in force at expiry for the following 12 months", async () => {
    const policy = await issue(["GL", "PROP"]);
    await addCyber(policy.id, "2026-11-01");
    // Property is dropped mid-term, so it shouldn't renew.
    await applyChange(
      policy.id,
      { kind: "COVERAGE_CHANGE", effectiveDate: "2027-01-01", add: [], remove: ["PROP"] },
      brokerId,
    );

    expect(await previewRenewal(policy.id)).toMatchObject({
      startDate: "2027-10-01",
      endDate: "2028-10-01",
      premiumCents: 109_500 + 73_000,
    });

    const renewal = await renewPolicy(policy.id, brokerId);
    const view = (await loadPolicyView(renewal.id))!;
    expect(view).toMatchObject({ startDate: "2027-10-01", endDate: "2028-10-01", termDays: 366, balanceCents: 182_500 });
    expect(view.coverage.map((c) => c.code).sort()).toEqual(["CYBER", "GL"]);
    expect(view.renewedFrom?.policyNumber).toBe(policy.policyNumber);
    // The renewal term hasn't started, so its premium is due on its start date, not now.
    expect(view.dueDate).toBe("2027-10-01");
    expect((await loadPolicyView(policy.id))!.dueDate).toBeNull();
    expect((await loadPolicyView(policy.id))!.renewal?.policyNumber).toBe(renewal.policyNumber);

    // The expiring policy's own statement is untouched.
    expect((await loadPolicyView(policy.id))!.statement).toHaveLength(4);
    await expect(renewPolicy(policy.id, brokerId)).rejects.toThrow(/already been renewed/);
  });

  it("won't renew a cancelled policy", async () => {
    const policy = await issue();
    await applyChange(policy.id, { kind: "CANCELLATION", effectiveDate: "2027-04-01" }, brokerId);
    await expect(renewPolicy(policy.id, brokerId)).rejects.toThrow(/cancelled/);
  });
});

describe("a policy and its renewal", () => {
  const PREMIUM = 109_500 + 73_000; // General Liability and Cyber for a full term

  /** A policy from Oct 1, 2026 and its renewal from Oct 1, 2027. */
  async function renewed() {
    const policy = await issue(["GL", "CYBER"]);
    const renewal = await renewPolicy(policy.id, brokerId);
    return { policy, renewal };
  }
  const issueOf = async (policyId: string) =>
    (await db.policyTransaction.findFirstOrThrow({ where: { policyId, type: "ISSUE" } })).id;
  const moveStart = async (policyId: string, startDate: string, extra: { reason?: string; renewal?: "FOLLOW" | "KEEP" } = {}) =>
    applyChange(
      policyId,
      {
        kind: "CORRECTION",
        transactionId: await issueOf(policyId),
        event: { type: "ISSUE", startDate, coverages: ["GL", "CYBER"] },
        ...extra,
      },
      brokerId,
    );
  const term = async (policyId: string) => {
    const view = (await loadPolicyView(policyId))!;
    return [view.startDate, view.endDate];
  };
  const notes = async (policyId: string) =>
    (await loadPolicyView(policyId))!.history.filter((h) => h.type === "NOTE").map((h) => h.summary);

  it("moves the renewal along when the policy's dates are corrected, so the terms still meet", async () => {
    const { policy, renewal } = await renewed();
    await payInFull(renewal.id);

    const { preview, affected } = await moveStart(policy.id, "2026-10-15");
    expect(preview.renewal).toMatchObject({ policyNumber: renewal.policyNumber, chosen: "FOLLOW", choices: ["FOLLOW"] });
    expect(preview.reasonRequired).toBe(false);
    expect(affected.map((a) => a.policyId)).toEqual([policy.id, renewal.id]);

    expect(await term(policy.id)).toEqual(["2026-10-15", "2027-10-15"]);
    expect(await term(renewal.id)).toEqual(["2027-10-15", "2028-10-15"]);

    // The renewal's old lines are reversed and rebooked for the new dates. A full term costs the same.
    const view = (await loadPolicyView(renewal.id))!;
    expect(view.statement.map((r) => [r.kind, r.amountCents])).toEqual([
      ["CHARGE", 73_000],
      ["CHARGE", 109_500],
      ["PAYMENT", -PREMIUM],
      ["REVERSAL", -73_000],
      ["REVERSAL", -109_500],
      ["CHARGE", 73_000],
      ["CHARGE", 109_500],
    ]);
    expect(view.balanceCents).toBe(0);
    expect(view.history.at(-1)).toMatchObject({ type: "CORRECTION", reason: expect.stringContaining(policy.policyNumber) });
    expect(view.gaps).toEqual([]);
    expect((await loadPolicyView(policy.id))!.gaps).toEqual([]);
  });

  it("never lets the two overlap", async () => {
    const { policy, renewal } = await renewed();

    // The policy now ends Oct 15, 2027, so the renewal can't stay at Oct 1.
    await expect(moveStart(policy.id, "2026-10-15", { renewal: "KEEP" })).rejects.toThrow(/can't stay where it is/);
    // And the renewal can't be moved into the term it renews.
    await expect(moveStart(renewal.id, "2027-09-15", { reason: "Typo" })).rejects.toThrow(/can't start before then/);

    expect(await term(policy.id)).toEqual(["2026-10-01", "2027-10-01"]);
    expect(await term(renewal.id)).toEqual(["2027-10-01", "2028-10-01"]);
  });

  it("allows a gap only as a deliberate choice with a reason, and records it on both policies", async () => {
    const { policy, renewal } = await renewed();

    // The policy really started two weeks earlier, so it ends two weeks earlier.
    const preview = await previewChange(policy.id, {
      kind: "CORRECTION",
      transactionId: await issueOf(policy.id),
      event: { type: "ISSUE", startDate: "2026-09-17", coverages: ["GL", "CYBER"] },
      renewal: "KEEP",
    });
    expect(preview.renewal).toMatchObject({
      chosen: "KEEP",
      choices: ["FOLLOW", "KEEP"],
      gapIfKept: { from: "2027-09-17", to: "2027-10-01", days: 14 },
    });
    expect(preview.reasonRequired).toBe(true);

    await expect(moveStart(policy.id, "2026-09-17", { renewal: "KEEP" })).rejects.toThrow(/needs a reason/);
    await moveStart(policy.id, "2026-09-17", { renewal: "KEEP", reason: "Customer asked for the renewal date to stay" });

    expect(await term(policy.id)).toEqual(["2026-09-17", "2027-09-17"]);
    expect(await term(renewal.id)).toEqual(["2027-10-01", "2028-10-01"]);
    expect((await loadPolicyView(policy.id))!.gaps).toMatchObject([
      { side: "AFTER", policyNumber: renewal.policyNumber, from: "2027-09-17", to: "2027-10-01", days: 14 },
    ]);
    expect((await loadPolicyView(renewal.id))!.gaps).toMatchObject([
      { side: "BEFORE", policyNumber: policy.policyNumber, days: 14 },
    ]);
    for (const id of [policy.id, renewal.id]) {
      expect(await notes(id)).toEqual([
        expect.stringMatching(/^No coverage from Sep 17, 2027 to Oct 1, 2027 \(14 days\).*Reason: Customer asked/),
      ]);
    }
  });

  it("needs a reason to start the renewal late, too", async () => {
    const { policy, renewal } = await renewed();
    await expect(moveStart(renewal.id, "2027-10-08")).rejects.toThrow(/needs a reason/);

    const { preview } = await moveStart(renewal.id, "2027-10-08", { reason: "Coverage lapsed for a week" });
    expect(preview.gapAfterOriginal).toMatchObject({ policyNumber: policy.policyNumber, from: "2027-10-01", to: "2027-10-08", days: 7 });
    expect(await notes(policy.id)).toHaveLength(1);
    expect(await notes(renewal.id)).toHaveLength(1);

    // Closing the gap again needs no reason.
    await moveStart(renewal.id, "2027-10-01");
    expect((await loadPolicyView(renewal.id))!.gaps).toEqual([]);
  });

  it("cancels the renewal from its first day when the policy is cancelled, unless the broker keeps it", async () => {
    const { policy, renewal } = await renewed();
    await payInFull(renewal.id);

    const { preview } = await applyChange(policy.id, { kind: "CANCELLATION", effectiveDate: "2027-04-01" }, brokerId);
    expect(preview.renewal).toMatchObject({ chosen: "FOLLOW", choices: ["FOLLOW", "KEEP"] });
    expect(preview.renewal!.follow).toMatchObject([{ action: "CANCEL", netChangeCents: -PREMIUM }]);

    // Everything paid on the renewal is now a credit, ready to refund.
    expect(await loadPolicyView(renewal.id)).toMatchObject({
      status: "CANCELLED",
      cancelledEffective: "2027-10-01",
      balanceCents: -PREMIUM,
      gaps: [],
    });
  });

  it("keeps the renewal through a cancellation if the broker says so and gives a reason", async () => {
    const { policy, renewal } = await renewed();
    await applyChange(
      policy.id,
      { kind: "CANCELLATION", effectiveDate: "2027-04-01", renewal: "KEEP", reason: "Seasonal business, back in October" },
      brokerId,
    );
    expect(await loadPolicyView(renewal.id)).toMatchObject({
      status: "ACTIVE",
      gaps: [{ side: "BEFORE", from: "2027-04-01", to: "2027-10-01", days: 183 }],
    });

    // The renewal was left apart on purpose, so a later fix to the cancellation date leaves it alone by default.
    const cancellation = await db.policyTransaction.findFirstOrThrow({ where: { policyId: policy.id, type: "CANCELLATION" } });
    const preview = await previewChange(policy.id, {
      kind: "CORRECTION",
      transactionId: cancellation.id,
      event: { type: "CANCELLATION", effectiveDate: "2027-05-01" },
    });
    expect(preview.renewal).toMatchObject({ chosen: "KEEP", gapIfKept: { days: 153 } });
  });

  it("refuses a confirmation if the gap being agreed to has changed since the preview", async () => {
    const { policy, renewal } = await renewed();
    const cancel = {
      kind: "CANCELLATION" as const,
      effectiveDate: "2027-04-01",
      renewal: "KEEP" as const,
      reason: "Seasonal business, back in October",
    };
    // The broker previews cancelling from April 1 and keeping the renewal: 183 days without cover.
    const previewed = await previewChange(policy.id, cancel);
    expect(previewed.renewal).toMatchObject({ chosen: "KEEP", gapIfKept: { from: "2027-04-01", to: "2027-10-01", days: 183 } });

    // Meanwhile the renewal is moved a month later. No amount on this policy changes,
    // but the gap the broker would be agreeing to is now 214 days.
    await moveStart(renewal.id, "2027-11-01", { reason: "Customer asked to restart in November" });
    const refused = await applyChange(policy.id, cancel, brokerId, previewed.fingerprint).catch((e) => e);
    expect(refused).toBeInstanceOf(PreviewChangedError);
    const fresh = (refused as PreviewChangedError).preview;
    expect(fresh.renewal).toMatchObject({ chosen: "KEEP", gapIfKept: { from: "2027-04-01", to: "2027-11-01", days: 214 } });
    expect((await loadPolicyView(policy.id))!.status).toBe("ACTIVE"); // nothing was saved

    // Shown the longer gap, the broker confirms it.
    await applyChange(policy.id, cancel, brokerId, fresh.fingerprint);
    expect(await loadPolicyView(renewal.id)).toMatchObject({
      gaps: [{ side: "BEFORE", from: "2027-04-01", to: "2027-11-01", days: 214 }],
    });
  });

  it("moves a whole chain of renewals together", async () => {
    const { policy, renewal } = await renewed();
    const second = await renewPolicy(renewal.id, brokerId);

    const { affected } = await moveStart(policy.id, "2026-09-17");
    expect(affected).toHaveLength(3);
    expect(await term(renewal.id)).toEqual(["2027-09-17", "2028-09-17"]);
    expect(await term(second.id)).toEqual(["2028-09-17", "2029-09-17"]);
  });

  it("refuses the change, and saves nothing, if the renewal can neither follow nor stay", async () => {
    const { policy, renewal } = await renewed();
    // The renewal has a change of its own early in its term.
    await applyChange(renewal.id, { kind: "COVERAGE_CHANGE", effectiveDate: "2027-10-05", add: ["PROP"], remove: [] }, brokerId);

    // Moving it to Oct 15 would strand that change before the term starts. Leaving it would overlap.
    await expect(moveStart(policy.id, "2026-10-15")).rejects.toThrow(/can't be moved with it/);
    expect(await term(policy.id)).toEqual(["2026-10-01", "2027-10-01"]);
    expect((await loadPolicyView(policy.id))!.history).toHaveLength(1);
  });

  it("leaves the renewal alone when the policy's dates don't move", async () => {
    const { policy } = await renewed();
    const { preview, affected } = await applyChange(
      policy.id,
      { kind: "COVERAGE_CHANGE", effectiveDate: "2026-12-01", add: ["PROP"], remove: [] },
      brokerId,
    );
    expect(preview.renewal).toBeNull();
    expect(affected).toHaveLength(1);
  });
});

describe("claims", () => {
  const claim = (policyId: string, coverageCode: string, lossDate: string, claimedCents = 400_000) =>
    fileClaim({ policyId, coverageCode, lossDate, description: "Water damage", claimedCents, userId: brokerId });

  it("pays the approved loss less the deductible, and never touches the premium statement", async () => {
    const policy = await issue(["GL"], "2026-10-01");
    const before = await statement(policy.id);

    const filed = await claim(policy.id, "GL", "2026-10-15");
    expect(filed.status).toBe("SUBMITTED");

    await expect(
      decideClaim(filed.id, { decision: "APPROVE", approvedLossCents: 500_000 }, brokerId),
    ).rejects.toThrow(/can't be more than/);
    const approved = await decideClaim(filed.id, { decision: "APPROVE", approvedLossCents: 350_000 }, brokerId);
    expect(approved).toMatchObject({ status: "APPROVED", deductibleCents: 50_000, payoutCents: 300_000 });

    const paid = await payClaim(filed.id);
    expect(paid.status).toBe("PAID");
    await expect(payClaim(filed.id)).rejects.toThrow(/Only an approved claim/);
    await expect(decideClaim(filed.id, { decision: "DENY", note: "late" }, brokerId)).rejects.toThrow(/already been decided/);

    expect(await statement(policy.id)).toEqual(before);
  });

  it("only accepts a loss on a day the coverage was in force", async () => {
    const policy = await issue(["GL"], "2026-10-01");
    await addCyber(policy.id, "2026-11-01");
    await expect(claim(policy.id, "CYBER", "2026-10-20")).rejects.toThrow(/wasn't in force on Oct 20, 2026/);
    await expect(claim(policy.id, "GL", "2026-09-30")).rejects.toThrow(/wasn't in force/);
    await expect(claim(policy.id, "PROP", "2026-11-05")).rejects.toThrow(/wasn't in force/);
    await expect(claim(policy.id, "GL", "2099-01-01")).rejects.toThrow(/future/);
    expect((await claim(policy.id, "CYBER", "2026-11-05")).status).toBe("SUBMITTED");
  });

  it("lets a corrected effective date bring a loss into cover, and flags claims that fall out of it", async () => {
    const policy = await issue(["GL"], "2026-10-01");
    const change = await addCyber(policy.id, "2026-11-01");
    const correct = (effectiveDate: string) =>
      applyChange(
        policy.id,
        {
          kind: "CORRECTION",
          transactionId: change.transaction.id,
          event: { type: "COVERAGE_CHANGE", effectiveDate, add: ["CYBER"], remove: [] },
        },
        brokerId,
      );

    // The reviewers' scenario matters for claims too: a loss on Oct 28 is only
    // covered once the start date is corrected to Oct 25.
    await expect(claim(policy.id, "CYBER", "2026-10-28")).rejects.toThrow(/wasn't in force/);
    await correct("2026-10-25");
    const filed = await claim(policy.id, "CYBER", "2026-10-28");
    expect((await claimsForPolicy(policy.id))[0].stillCovered).toBe(true);

    // If the date is then moved later again, the claim is flagged and can't be approved.
    await correct("2026-11-05");
    expect((await claimsForPolicy(policy.id))[0].stillCovered).toBe(false);
    await expect(
      decideClaim(filed.id, { decision: "APPROVE", approvedLossCents: 100_000 }, brokerId),
    ).rejects.toThrow(/no longer in force/);
    const denied = await decideClaim(filed.id, { decision: "DENY", note: "Not in force on the loss date" }, brokerId);
    expect(denied.status).toBe("DENIED");
  });

  it("caps the payout at the coverage limit and pays nothing below the deductible", async () => {
    const policy = await issue(["GL", "PROP"], "2026-10-01");
    const big = await claim(policy.id, "PROP", "2026-10-10", 9_000_000);
    expect(
      (await decideClaim(big.id, { decision: "APPROVE", approvedLossCents: 9_000_000 }, brokerId)).payoutCents,
    ).toBe(5_000_000);
    const small = await claim(policy.id, "GL", "2026-10-10", 30_000);
    expect(
      (await decideClaim(small.id, { decision: "APPROVE", approvedLossCents: 30_000 }, brokerId)).payoutCents,
    ).toBe(0);
  });

  it("uses today's date sensibly", () => {
    expect(todayISO()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("a very large loss", () => {
  it("is refused with a clear message when it is more than can be stored, and accepted up to that", async () => {
    const policy = await issue();
    const file = (claimedCents: number) =>
      fileClaim({ policyId: policy.id, coverageCode: "GL", lossDate: "2026-10-15", description: "Fire", claimedCents, userId: brokerId });

    // $25,000,000.00 used to pass validation and then fail in the database.
    await expect(file(2_500_000_000)).rejects.toThrow(
      "The largest loss that can be entered is $20,000,000.00. For a larger loss, enter $20,000,000.00 and give the full figure in the description. The payout is the same either way, because General Liability pays at most $1,000,000.00 for one claim.",
    );
    expect(await db.claim.count()).toBe(0);

    // The largest amount that can be entered is saved, and pays out the coverage's limit.
    const claim = await file(2_000_000_000);
    const approved = await decideClaim(claim.id, { decision: "APPROVE", approvedLossCents: 2_000_000_000 }, brokerId);
    expect(approved).toMatchObject({ status: "APPROVED", claimedCents: 2_000_000_000, payoutCents: 100_000_000 });
  });
});

describe("claims handled by several people at once", () => {
  const file = (policyId: string, description: string) =>
    fileClaim({ policyId, coverageCode: "GL", lossDate: "2026-10-15", description, claimedCents: 400_000, userId: brokerId });

  it("lets only one decision stand when two brokers decide at the same moment", async () => {
    const policy = await issue();
    const claim = await file(policy.id, "A customer slipped on a wet floor");
    const results = await Promise.allSettled([
      decideClaim(claim.id, { decision: "APPROVE", approvedLossCents: 350_000 }, brokerId),
      decideClaim(claim.id, { decision: "DENY", note: "Not the business's liability" }, brokerId),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason.message).toMatch(/already been decided/);
    // The claim holds exactly the decision that was reported as made.
    const made = (results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ status: string }>).value;
    const saved = await db.claim.findUniqueOrThrow({ where: { id: claim.id } });
    expect(saved.status).toBe(made.status);
    expect(saved.status === "APPROVED" ? saved.payoutCents : saved.decisionNote).toBe(
      saved.status === "APPROVED" ? 300_000 : "Not the business's liability",
    );
  });

  it("gives every claim its own number when several are filed at the same moment", async () => {
    const policy = await issue();
    const filed = await Promise.all(["one", "two", "three", "four", "five"].map((n) => file(policy.id, `Loss ${n}`)));
    const numbers = filed.map((c) => c.claimNumber).sort();
    expect(numbers).toEqual(["CLM-2026-0001", "CLM-2026-0002", "CLM-2026-0003", "CLM-2026-0004", "CLM-2026-0005"]);
    expect(await db.claim.count()).toBe(5);
  });
});

describe("confirming a renewal the broker was shown", () => {
  it("creates nothing if the expiring policy changed after the renewal was shown", async () => {
    const policy = await issue();
    const shown = await previewRenewal(policy.id);
    expect(shown.premiumCents).toBe(109_500);

    // Cyber is added to the expiring policy. The renewal would now carry it, at $1,825.00.
    await addCyber(policy.id, "2026-11-01");
    await expect(renewPolicy(policy.id, brokerId, shown.fingerprint)).rejects.toThrow(/has changed since the renewal was shown/);
    expect(await db.policy.count()).toBe(1);

    // Shown the new terms, the broker renews at the higher premium.
    const fresh = await previewRenewal(policy.id);
    expect(fresh.premiumCents).toBe(182_500);
    const renewal = await renewPolicy(policy.id, brokerId, fresh.fingerprint);
    expect((await loadPolicyView(renewal.id))!.balanceCents).toBe(182_500);
  });

  it("creates one renewal when two brokers click at the same moment", async () => {
    const policy = await issue();
    const shown = await previewRenewal(policy.id);
    const results = await Promise.allSettled([
      renewPolicy(policy.id, brokerId, shown.fingerprint),
      renewPolicy(policy.id, brokerId, shown.fingerprint),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(await db.policy.count()).toBe(2);
  });
});

describe("a policy cancelled from its first day, where a line was moved by a cent", () => {
  const ADJUSTED =
    "$730.00 × 1 ÷ 366 days = $1.99, adjusted by $0.01 to $2.00 so that this coverage comes to exactly $0.00, because the policy was cancelled from its first day";

  /**
   * A 366-day term with Cyber on for a single day, then cancelled from the first day. The day
   * is chosen so that the charge and the first credit differ by $2.00 while a day costs $1.99:
   * the case where a cent has to be found.
   */
  async function cancelledFromDayOne() {
    const day = (n: number) => new Date(Date.UTC(2027, 9, 1) + n * 86_400_000).toISOString().slice(0, 10);
    const cyberFor = (days: number) => proRate(73_000, days, 366);
    let on = 1;
    while (cyberFor(366 - on) - cyberFor(365 - on) !== 200) on++;

    const policy = await issue(["GL"], "2027-10-01");
    await addCyber(policy.id, day(on));
    await applyChange(policy.id, { kind: "COVERAGE_CHANGE", effectiveDate: day(on + 1), add: [], remove: ["CYBER"] }, brokerId);
    const cancellation = await applyChange(policy.id, { kind: "CANCELLATION", effectiveDate: "2027-10-01" }, brokerId);
    return { policy, cancellationId: cancellation.transaction.id };
  }
  const shown = (row: { calc: unknown; amountCents: number }) =>
    formulaFor({ ...(row.calc as Parameters<typeof formulaFor>[0]), amountCents: row.amountCents });

  it("comes to exactly zero, and the moved line shows its real arithmetic", async () => {
    const { policy } = await cancelledFromDayOne();
    const view = (await loadPolicyView(policy.id))!;
    expect(view.balanceCents).toBe(0);
    const credit = view.statement.find((r) => r.coverageCode === "CYBER" && r.description.includes("unused days after cancellation"))!;
    expect(credit).toMatchObject({ kind: "CREDIT", amountCents: -200, calc: { days: 1, roundingCents: -1 } });
    expect(shown(credit)).toBe(ADJUSTED);
  });

  it("shows the same arithmetic when that line is reversed by a correction, in the preview and on the statement", async () => {
    const { policy, cancellationId } = await cancelledFromDayOne();
    const laterDate = {
      kind: "CORRECTION" as const,
      transactionId: cancellationId,
      event: { type: "CANCELLATION" as const, effectiveDate: "2028-04-01" },
    };

    // The broker's preview of the reversal: +$2.00, cancelling the −$2.00 credit.
    const preview = await previewChange(policy.id, laterDate);
    const previewed = preview.reversals.find((l) => l.coverageCode === "CYBER")!;
    expect(previewed).toMatchObject({ amountCents: 200, calc: { days: 1, roundingCents: 1 } });
    expect(shown(previewed)).toBe(ADJUSTED);

    // And the line as posted.
    await applyChange(policy.id, laterDate, brokerId, preview.fingerprint);
    const view = (await loadPolicyView(policy.id))!;
    const reversal = view.statement.find((r) => r.kind === "REVERSAL" && r.coverageCode === "CYBER")!;
    expect(reversal).toMatchObject({ amountCents: 200, calc: { days: 1, roundingCents: 1 } });
    expect(shown(reversal)).toBe(ADJUSTED);

    // Every line on the statement shows arithmetic that is true: the result after "=" is what the formula comes to.
    for (const row of view.statement.filter((r) => r.calc)) {
      const result = proRate(row.calc!.annualPremiumCents, row.calc!.days, row.calc!.termDays);
      expect(shown(row)).toContain(`days = ${formatUSD(result)}`);
    }
  });
});

describe("explaining the amount due", () => {
  const moveCyber = (policyId: string, changeId: string, effectiveDate: string) =>
    applyChange(
      policyId,
      { kind: "CORRECTION", transactionId: changeId, event: { type: "COVERAGE_CHANGE", effectiveDate, add: ["CYBER"], remove: [] } },
      brokerId,
    );
  /** A payment of a set amount, as when a bank debit clears for what was due when it was made. */
  async function pay(policyId: string, amountCents: number) {
    const payment = await db.payment.create({ data: { policyId, amountCents, status: "SUCCEEDED" } });
    await db.ledgerEntry.create({
      data: { policyId, kind: "PAYMENT", amountCents: -amountCents, description: "Payment received (test)", paymentId: payment.id },
    });
  }
  const rows = async (policyId: string) => {
    const view = (await loadPolicyView(policyId))!;
    const reasons = view.dueBecause.map((r) => [r.title, r.netCents]);
    // Whatever is shown must come to the amount on the Pay button.
    expect(view.dueBecause.reduce((sum, r) => sum + r.netCents, 0)).toBe(view.balanceCents);
    return reasons;
  };

  it("lists a credit and a charge made while a payment was clearing, which together come to what is due", async () => {
    const policy = await issue();
    await payInFull(policy.id);
    const change = await addCyber(policy.id, "2026-11-01"); // $668.00, paid by a bank debit that takes days
    await moveCyber(policy.id, change.transaction.id, "2026-11-08"); // a week later: $14.00 less
    await moveCyber(policy.id, change.transaction.id, "2026-10-25"); // two weeks earlier: $28.00 more
    await pay(policy.id, 66_800); // the debit clears for the original amount

    expect((await loadPolicyView(policy.id))!.balanceCents).toBe(1_400);
    expect(await rows(policy.id)).toEqual([
      ["Correction to #2", -1_400],
      ["Correction to #3", 2_800],
    ]);
  });

  it("falls back to everything since the balance was last zero when a payment covered part of a change", async () => {
    const policy = await issue();
    await payInFull(policy.id);
    await addCyber(policy.id, "2026-11-01"); // $668.00
    await pay(policy.id, 60_000); // an odd amount, so no run of changes comes to what is left

    expect(await rows(policy.id)).toEqual([
      ["Coverage changed", 66_800],
      ["Payment received (test)", -60_000],
    ]);
  });

  it("explains nothing when nothing is due", async () => {
    const policy = await issue();
    await payInFull(policy.id);
    expect(await rows(policy.id)).toEqual([]);
  });
});

describe("explaining a correction on a cancelled policy", () => {
  it("counts the days the customer is paying for, not charged days plus credited days", async () => {
    const policy = await issue(); // Oct 1, 2026 to Oct 1, 2027
    await applyChange(policy.id, { kind: "CANCELLATION", effectiveDate: "2027-04-01" }, brokerId);
    // 182 days of cover at $3.00 a day.
    expect((await loadPolicyView(policy.id))!.balanceCents).toBe(54_600);

    // The policy really started a day later. One day less is covered before the cancellation.
    const issueId = (await db.policyTransaction.findFirstOrThrow({ where: { policyId: policy.id, seq: 1 } })).id;
    await applyChange(
      policy.id,
      { kind: "CORRECTION", transactionId: issueId, event: { type: "ISSUE", startDate: "2026-10-02", coverages: ["GL"] } },
      brokerId,
    );
    const view = (await loadPolicyView(policy.id))!;
    expect(view.balanceCents).toBe(54_300);
    expect(view.history.at(-1)!.explanation).toBe(
      "General Liability now counts 1 fewer day (181 instead of 182) at $3.00 a day, so its charge changes from $546.00 to $543.00. In total, $3.00 less is owed.",
    );
  });

  it("talks about the credit when only the date coverage was removed is corrected", async () => {
    const policy = await issue(["GL", "CYBER"]);
    const removal = await applyChange(
      policy.id,
      { kind: "COVERAGE_CHANGE", effectiveDate: "2027-04-01", add: [], remove: ["CYBER"] },
      brokerId,
    );
    // Cyber really came off a week earlier, so a week more is handed back.
    await applyChange(
      policy.id,
      {
        kind: "CORRECTION",
        transactionId: removal.transaction.id,
        event: { type: "COVERAGE_CHANGE", effectiveDate: "2027-03-25", add: [], remove: ["CYBER"] },
      },
      brokerId,
    );
    expect((await loadPolicyView(policy.id))!.history.at(-1)!.explanation).toBe(
      "Cyber Liability is now credited for 7 more days (190 instead of 183) at $2.00 a day, so its credit changes from $366.00 to $380.00. In total, $14.00 less is owed.",
    );
  });
});

describe("confirming a change the broker previewed", () => {
  it("saves nothing if the figures have moved since the preview, and shows the new ones", async () => {
    const policy = await issue();
    const cancel = { kind: "CANCELLATION" as const, effectiveDate: "2027-04-01" };

    // The broker previews a cancellation while the premium is unpaid: the customer would still owe.
    const previewed = await previewChange(policy.id, cancel);
    expect(previewed).toMatchObject({ balanceBeforeCents: 109_500, balanceAfterCents: 54_600 });

    // The customer's payment lands before the broker confirms. Confirming now would refund instead.
    await payInFull(policy.id);
    const refused = await applyChange(policy.id, cancel, brokerId, previewed.fingerprint).catch((e) => e);
    expect(refused).toBeInstanceOf(PreviewChangedError);
    const fresh = (refused as PreviewChangedError).preview;
    expect(fresh).toMatchObject({ balanceBeforeCents: 0, balanceAfterCents: -54_900 });

    // Nothing was saved.
    const view = (await loadPolicyView(policy.id))!;
    expect(view.status).toBe("ACTIVE");
    expect(view.history).toHaveLength(1);

    // Confirming the new figures saves the change.
    await applyChange(policy.id, cancel, brokerId, fresh.fingerprint);
    expect((await loadPolicyView(policy.id))!).toMatchObject({ status: "CANCELLED", balanceCents: -54_900 });
  });

  it("saves when the figures are the ones previewed", async () => {
    const policy = await issue();
    const add = { kind: "COVERAGE_CHANGE" as const, effectiveDate: "2026-11-01", add: ["CYBER"], remove: [] };
    const previewed = await previewChange(policy.id, add);
    // Previewing again gives the same fingerprint, and a different change gives a different one.
    expect((await previewChange(policy.id, add)).fingerprint).toBe(previewed.fingerprint);
    expect((await previewChange(policy.id, { ...add, effectiveDate: "2026-11-02" })).fingerprint).not.toBe(previewed.fingerprint);

    await applyChange(policy.id, add, brokerId, previewed.fingerprint);
    expect((await loadPolicyView(policy.id))!.balanceCents).toBe(109_500 + 66_800);
  });
});

describe("issuing from a signed application", () => {
  const signedApplication = (coverageCodes = ["GL"]) =>
    db.application.create({
      data: {
        customerId,
        startDate: new Date("2026-10-01"),
        coverageCodes,
        premiumCents: 109_500,
        status: "SIGNED",
        signedAt: new Date(),
        signerName: "Tess Tester",
        signerEmail: "tess@test-bakery.test",
        signerUserId: brokerId,
        createdById: brokerId,
      },
    });

  it("issues one policy when two brokers click at the same moment", async () => {
    const application = await signedApplication();
    const results = await Promise.allSettled([
      issueFromApplication(application.id, brokerId),
      issueFromApplication(application.id, brokerId),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason).toBeInstanceOf(PolicyRuleError);
    expect(refused.reason.message).toMatch(/already been issued/);

    // One policy, one premium charge, and the application points at it.
    const policies = await db.policy.findMany({ where: { customerId } });
    expect(policies).toHaveLength(1);
    expect(await db.ledgerEntry.count()).toBe(1);
    expect(await db.application.findUniqueOrThrow({ where: { id: application.id } })).toMatchObject({
      status: "ISSUED",
      policyId: policies[0].id,
    });

    // A later retry is refused too.
    await expect(issueFromApplication(application.id, brokerId)).rejects.toThrow(/already been issued/);
    expect(await db.policy.count()).toBe(1);
  });

  it("can't be issued twice even if a late status check sets it back to signed", async () => {
    const application = await signedApplication();
    const policy = await issueFromApplication(application.id, brokerId);

    // What a slow DocuSign answer used to do: write "signed" over an application that had since been issued.
    await db.application.update({ where: { id: application.id }, data: { status: "SIGNED" } });
    await expect(issueFromApplication(application.id, brokerId)).rejects.toThrow(/already been issued/);
    expect(await db.policy.count()).toBe(1);
    expect((await db.application.findUniqueOrThrow({ where: { id: application.id } })).policyId).toBe(policy.id);
  });

  it("issues at the prices the customer signed for, even if the rate table has changed since", async () => {
    // Signed when General Liability was $1,000.00 a year. Today's rate table says $1,095.00.
    const application = await db.application.create({
      data: {
        customerId,
        startDate: new Date("2026-10-01"),
        coverageCodes: ["GL"],
        premiumCents: 100_000,
        signedRates: [{ code: "GL", annualPremiumCents: 100_000 }],
        status: "SIGNED",
        signedAt: new Date(),
        signerName: "Tess Tester",
        signerEmail: "tess@test-bakery.test",
        signerUserId: brokerId,
        createdById: brokerId,
      },
    });
    const policy = await issueFromApplication(application.id, brokerId);

    const view = (await loadPolicyView(policy.id))!;
    expect(view.balanceCents).toBe(100_000);
    expect(view.statement[0]).toMatchObject({ kind: "CHARGE", amountCents: 100_000, calc: { annualPremiumCents: 100_000 } });
    expect(view.coverage).toMatchObject([{ code: "GL", annualPremiumCents: 100_000 }]);
    // A coverage added later, which wasn't on the application, is priced from today's table.
    await addCyber(policy.id, "2026-11-01");
    expect((await loadPolicyView(policy.id))!.balanceCents).toBe(100_000 + 66_800);
  });

  it("refuses an older application whose signed total no longer matches today's prices", async () => {
    // Sent before prices were saved with the application: only the signed total is known.
    const application = await signedApplication();
    await db.application.update({ where: { id: application.id }, data: { premiumCents: 100_000 } });

    await expect(issueFromApplication(application.id, brokerId)).rejects.toThrow(
      "Prices have changed since this application was signed: it was signed for $1,000.00 and would now be $1,095.00. Send a new application for signature.",
    );
    expect(await db.policy.count()).toBe(0);
    expect((await db.application.findUniqueOrThrow({ where: { id: application.id } })).status).toBe("SIGNED");
  });

  it("leaves the application signed, with no policy, if issuing fails part-way", async () => {
    const application = await signedApplication(["NOT-A-COVERAGE"]);
    await expect(issueFromApplication(application.id, brokerId)).rejects.toThrow();
    expect(await db.policy.count()).toBe(0);
    expect(await db.application.findUniqueOrThrow({ where: { id: application.id } })).toMatchObject({
      status: "SIGNED",
      policyId: null,
    });
  });
});

