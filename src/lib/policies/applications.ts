import "server-only";
import { db } from "@/lib/db";
import {
  addOneYear,
  coverageName,
  formatDate,
  formatUSD,
  fromJSDate,
  getCoverage,
  PolicyRuleError,
  replay,
  toJSDate,
  totalPremiumCents,
  type ISODate,
} from "@/lib/engine";
import {
  createEnvelope,
  createSigningUrl,
  getEnvelopeStatus,
  voidEnvelope,
} from "@/lib/integrations/docusign";
import { issuePolicyIn } from "./service";

/**
 * The application step: before a policy is issued, the policyholder e-signs an
 * application through DocuSign. The flow is
 *
 *   broker sends application -> policyholder signs in the app -> broker issues
 *
 * As with payments, "signed" is decided by DocuSign's servers. Both the
 * webhook and the return from the signing screen just trigger a fresh status
 * check against DocuSign.
 */

/** The public address DocuSign can reach us on, when deployed. */
function webhookUrl(): string | undefined {
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  return host ? `https://${host}/api/docusign/webhook` : undefined;
}

export async function sendApplication(input: {
  customerId: string;
  startDate: ISODate;
  coverageCodes: string[];
  userId: string;
}) {
  const customer = await db.customer.findUniqueOrThrow({
    where: { id: input.customerId },
    include: { users: { where: { role: "POLICYHOLDER" }, orderBy: { createdAt: "asc" }, take: 1 } },
  });
  const signer = customer.users[0];
  if (!signer) throw new PolicyRuleError("This customer has no policyholder login to sign with.");

  // Validate and price exactly as issuing would.
  const endDate = addOneYear(input.startDate);
  const coverages = input.coverageCodes.map((code) => ({
    code,
    annualPremiumCents: getCoverage(code).annualPremiumCents,
  }));
  const premiumCents = totalPremiumCents(
    replay([{ id: "application", event: { type: "ISSUE", startDate: input.startDate, endDate, coverages } }]),
  );

  const application = await db.application.create({
    data: {
      customerId: customer.id,
      startDate: toJSDate(input.startDate),
      coverageCodes: input.coverageCodes,
      premiumCents,
      signerName: signer.name,
      signerEmail: signer.email,
      signerUserId: signer.id,
      createdById: input.userId,
    },
  });

  try {
    const envelopeId = await createEnvelope({
      subject: `Insurance application for ${customer.businessName}`,
      documentName: "Small Business Package application",
      documentHtml: applicationHtml({
        businessName: customer.businessName,
        address: `${customer.addressLine1}, ${customer.city}, ${customer.state} ${customer.postalCode}`,
        signerName: signer.name,
        startDate: input.startDate,
        endDate,
        coverages,
        premiumCents,
      }),
      signer: { name: signer.name, email: signer.email, clientUserId: signer.id },
      webhookUrl: webhookUrl(),
      applicationId: application.id,
    });
    return db.application.update({ where: { id: application.id }, data: { docusignEnvelopeId: envelopeId } });
  } catch (error) {
    // Nothing was sent, so don't leave an application nobody can sign.
    await db.application.delete({ where: { id: application.id } });
    throw error;
  }
}

/** The link that opens DocuSign's signing screen for the policyholder. */
export async function signingUrlFor(applicationId: string, userId: string, origin: string) {
  const application = await db.application.findUniqueOrThrow({ where: { id: applicationId } });
  if (application.signerUserId !== userId || !application.docusignEnvelopeId) {
    throw new PolicyRuleError("This application isn't yours to sign.");
  }
  if (application.status !== "AWAITING_SIGNATURE") {
    throw new PolicyRuleError("This application has already been dealt with.");
  }
  return createSigningUrl(
    application.docusignEnvelopeId,
    { name: application.signerName, email: application.signerEmail, clientUserId: application.signerUserId },
    `${origin}/portal/applications/${application.id}/signed`,
  );
}

/** Brings an application in line with what DocuSign says about its envelope. */
export async function syncApplication(applicationId: string) {
  const application = await db.application.findUnique({ where: { id: applicationId } });
  if (!application?.docusignEnvelopeId || application.status !== "AWAITING_SIGNATURE") return application;

  const envelope = await getEnvelopeStatus(application.docusignEnvelopeId);
  if (envelope.status === "completed") {
    return db.application.update({
      where: { id: application.id },
      data: { status: "SIGNED", signedAt: envelope.completedAt ? new Date(envelope.completedAt) : new Date() },
    });
  }
  if (envelope.status === "declined" || envelope.status === "voided") {
    return db.application.update({ where: { id: application.id }, data: { status: "VOIDED" } });
  }
  return application;
}

export async function syncApplicationByEnvelope(envelopeId: string) {
  const application = await db.application.findUnique({ where: { docusignEnvelopeId: envelopeId } });
  return application ? syncApplication(application.id) : null;
}

/** Backstop for missed webhooks, like payments: re-check anything still unsigned. */
export async function syncPendingApplications(customerId: string) {
  const pending = await db.application.findMany({ where: { customerId, status: "AWAITING_SIGNATURE" } });
  for (const application of pending) {
    try {
      await syncApplication(application.id);
    } catch (error) {
      console.error("Could not check application with DocuSign", error);
    }
  }
}

/** Issues the policy from a signed application. Only possible once it's signed. */
export async function issueFromApplication(applicationId: string, userId: string) {
  const application = await syncApplication(applicationId);
  if (!application) throw new PolicyRuleError("Application not found.");
  if (application.status === "ISSUED") throw new PolicyRuleError("This application has already been issued.");
  if (application.status !== "SIGNED") {
    throw new PolicyRuleError("The policyholder hasn't signed this application yet.");
  }
  // The application is claimed and the policy created in one transaction. The
  // claim only succeeds for an application that is still SIGNED, and it locks
  // the row, so two brokers clicking at once (or a retry after a failure)
  // can't both issue: the second waits, then finds it already issued. If
  // creating the policy fails, the claim is undone with it.
  return db.$transaction(async (tx) => {
    const claimed = await tx.application.updateMany({
      where: { id: application.id, status: "SIGNED" },
      data: { status: "ISSUED" },
    });
    if (claimed.count !== 1) throw new PolicyRuleError("This application has already been issued.");
    const policy = await issuePolicyIn(tx, {
      customerId: application.customerId,
      startDate: fromJSDate(application.startDate),
      coverageCodes: application.coverageCodes,
      userId,
    });
    await tx.application.update({ where: { id: application.id }, data: { policyId: policy.id } });
    return policy;
  });
}

export async function withdrawApplication(applicationId: string) {
  const application = await db.application.findUniqueOrThrow({ where: { id: applicationId } });
  if (application.status !== "AWAITING_SIGNATURE") {
    throw new PolicyRuleError("Only an unsigned application can be withdrawn.");
  }
  if (application.docusignEnvelopeId) {
    await voidEnvelope(application.docusignEnvelopeId, "Withdrawn by the broker");
  }
  await db.application.update({ where: { id: application.id }, data: { status: "VOIDED" } });
}

const escape = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** The document the policyholder signs. "/sig1/" and "/date1/" mark where DocuSign puts its fields. */
function applicationHtml(a: {
  businessName: string;
  address: string;
  signerName: string;
  startDate: ISODate;
  endDate: ISODate;
  coverages: { code: string; annualPremiumCents: number }[];
  premiumCents: number;
}) {
  const rows = a.coverages
    .map(
      (c) =>
        `<tr><td style="padding:6px 0">${escape(coverageName(c.code))}</td><td style="padding:6px 0;text-align:right">${formatUSD(c.annualPremiumCents)}</td></tr>`,
    )
    .join("");
  return `<!DOCTYPE html>
<html><body style="font-family:Helvetica,Arial,sans-serif;font-size:12pt;color:#111;margin:48px">
<h1 style="font-size:18pt;margin:0">Application for insurance</h1>
<p style="color:#555;margin-top:4px">Small Business Package · demonstration document, not a real insurance contract</p>
<h2 style="font-size:13pt;margin-top:28px">Applicant</h2>
<p>${escape(a.businessName)}<br/>${escape(a.address)}</p>
<h2 style="font-size:13pt;margin-top:28px">Requested coverage</h2>
<p>Policy term: ${formatDate(a.startDate)} to ${formatDate(a.endDate)} (12 months)</p>
<table style="width:100%;border-collapse:collapse">
<tr><th style="text-align:left;border-bottom:1px solid #999;padding:6px 0">Coverage</th><th style="text-align:right;border-bottom:1px solid #999;padding:6px 0">Annual premium</th></tr>
${rows}
<tr><td style="border-top:1px solid #999;padding:6px 0"><b>Total premium for the term</b></td><td style="border-top:1px solid #999;padding:6px 0;text-align:right"><b>${formatUSD(a.premiumCents)}</b></td></tr>
</table>
<h2 style="font-size:13pt;margin-top:28px">Declaration</h2>
<p>I confirm that the information above is correct, that I am authorized to apply for this insurance on behalf of ${escape(a.businessName)}, and that I ask the broker to issue the policy on these terms. The premium is due in full when the policy is issued.</p>
<table style="margin-top:48px;width:100%"><tr>
<td style="width:60%">Signed by ${escape(a.signerName)}<br/><br/><span style="color:#fff">/sig1/</span></td>
<td>Date<br/><br/><span style="color:#fff">/date1/</span></td>
</tr></table>
</body></html>`;
}
