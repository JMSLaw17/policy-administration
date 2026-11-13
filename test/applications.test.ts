import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { PREMIUM_DUE_RULE } from "@/lib/engine";
import { issueFromApplication, sendApplication, syncApplication, withdrawApplication } from "@/lib/policies/applications";
import { loadPolicyView } from "@/lib/policies/view";

/**
 * Tests of how a signed application becomes a policy, against a real (test)
 * database, with a stand-in for DocuSign that can be made to answer late.
 */

const docusign = vi.hoisted(() => ({
  /** What DocuSign says about the envelope. */
  status: "completed",
  /** Runs while DocuSign is "thinking", before it answers: the place another request can get in. */
  meanwhile: async () => {},
  /** The document last sent for signature. */
  sentHtml: "",
}));

vi.mock("@/lib/integrations/docusign", () => ({
  DocuSignError: class DocuSignError extends Error {},
  DocuSignNotConfiguredError: class DocuSignNotConfiguredError extends Error {},
  isDocuSignConfigured: () => true,
  createEnvelope: async (input: { documentHtml: string }) => {
    docusign.sentHtml = input.documentHtml;
    return `env_${Math.random().toString(36).slice(2)}`;
  },
  createSigningUrl: async () => "https://demo.docusign.net/sign",
  getEnvelopeStatus: async () => {
    await docusign.meanwhile();
    return { status: docusign.status, completedAt: "2026-11-12T09:37:29Z" };
  },
  voidEnvelope: async () => {
    await docusign.meanwhile();
  },
  downloadSignedDocument: async () => new ArrayBuffer(0),
}));

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
  await db.user.create({
    data: { email: "tess@test-bakery.test", name: "Tess Tester", role: "POLICYHOLDER", passwordHash: "x", customerId },
  });
});

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE "Application", "LedgerEntry", "PolicyTransaction", "Policy" RESTART IDENTITY CASCADE',
  );
  docusign.status = "completed";
  docusign.meanwhile = async () => {};
});

/** An application sent for signature, which the app hasn't yet heard is signed. */
const sentApplication = () =>
  db.application.create({
    data: {
      customerId,
      startDate: new Date("2026-10-01"),
      coverageCodes: ["GL"],
      premiumCents: 109_500,
      status: "AWAITING_SIGNATURE",
      docusignEnvelopeId: `env_${Math.random().toString(36).slice(2)}`,
      signerName: "Tess Tester",
      signerEmail: "tess@test-bakery.test",
      signerUserId: brokerId,
      createdById: brokerId,
    },
  });

const reload = (id: string) => db.application.findUniqueOrThrow({ where: { id } });

describe("checking an application's status with DocuSign", () => {
  it("marks it signed once DocuSign says the envelope is complete", async () => {
    const application = await sentApplication();
    expect(await syncApplication(application.id)).toMatchObject({ status: "SIGNED" });
    expect((await reload(application.id)).signedAt?.toISOString()).toBe("2026-11-12T09:37:29.000Z");
  });

  it("doesn't reopen an application that was issued while DocuSign was answering", async () => {
    const application = await sentApplication();
    let policyId = "";

    // A status check starts and waits on DocuSign. While it waits, the webhook marks the
    // application signed and the broker issues the policy.
    docusign.meanwhile = async () => {
      docusign.meanwhile = async () => {};
      await syncApplication(application.id);
      policyId = (await issueFromApplication(application.id, brokerId)).id;
    };
    // The slow check then gets its answer, "completed". It must not write "signed" over "issued".
    expect(await syncApplication(application.id)).toMatchObject({ status: "ISSUED", policyId });
    expect(await reload(application.id)).toMatchObject({ status: "ISSUED", policyId });

    // So the application can't be issued a second time.
    await expect(issueFromApplication(application.id, brokerId)).rejects.toThrow(/already been issued/);
    expect(await db.policy.count()).toBe(1);
  });

  it("doesn't void an application that was signed while a withdrawal was in flight", async () => {
    const application = await sentApplication();
    docusign.meanwhile = async () => {
      docusign.meanwhile = async () => {};
      await syncApplication(application.id);
    };
    await expect(withdrawApplication(application.id)).rejects.toThrow(/Only an unsigned application/);
    expect(await reload(application.id)).toMatchObject({ status: "SIGNED" });
  });
});

describe("sending an application for signature", () => {
  it("saves the prices on the document, and the policy is issued at exactly those", async () => {
    const application = await sendApplication({
      customerId,
      startDate: "2027-01-01",
      coverageCodes: ["GL", "CYBER"],
      userId: brokerId,
    });
    expect(application).toMatchObject({
      premiumCents: 182_500,
      signedRates: [
        { code: "GL", annualPremiumCents: 109_500 },
        { code: "CYBER", annualPremiumCents: 73_000 },
      ],
    });
    // The document shows those prices, and says when the premium is due: the same rule the policy page applies.
    expect(docusign.sentHtml).toContain("$1,095.00");
    expect(docusign.sentHtml).toContain("$730.00");
    expect(docusign.sentHtml).toContain("$1,825.00");
    expect(docusign.sentHtml).toContain(PREMIUM_DUE_RULE);

    // Signed, then issued: the first charges are the signed prices.
    await syncApplication(application.id);
    const policy = await issueFromApplication(application.id, brokerId);
    const view = (await loadPolicyView(policy.id))!;
    expect(view.statement.map((r) => [r.coverageCode, r.amountCents])).toEqual([
      ["GL", 109_500],
      ["CYBER", 73_000],
    ]);
    // The term starts in the future, so the premium is due on its first day, as the document says.
    expect(view.dueDate).toBe("2027-01-01");
  });
});

