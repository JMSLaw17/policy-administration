import { logIntegrationEvent } from "@/lib/integrations/log";
import { isDocuSignConfigured } from "@/lib/integrations/docusign";
import { syncApplicationByEnvelope } from "@/lib/policies/applications";

/**
 * DocuSign calls this when an envelope is completed, declined, or voided.
 *
 * We don't trust what the request says. It is only a nudge: we take the
 * envelope id from it and ask DocuSign's API for that envelope's real status.
 * A forged request can therefore do nothing except trigger a status check.
 */
export async function POST(request: Request) {
  if (!isDocuSignConfigured()) return new Response("Not configured", { status: 400 });

  let body: { event?: string; data?: { envelopeId?: string } };
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid body", { status: 400 });
  }
  const envelopeId = body.data?.envelopeId;
  if (typeof envelopeId !== "string" || !/^[0-9a-f-]{36}$/i.test(envelopeId)) {
    return new Response("Missing envelope id", { status: 400 });
  }

  const application = await syncApplicationByEnvelope(envelopeId);
  // Only log events for envelopes we actually sent.
  if (application) {
    await logIntegrationEvent({
      provider: "docusign",
      direction: "INBOUND",
      eventType: String(body.event ?? "envelope.event"),
      externalId: envelopeId,
      payload: { event: body.event, envelopeId, applicationStatus: application.status },
    });
  }
  return Response.json({ received: true });
}
