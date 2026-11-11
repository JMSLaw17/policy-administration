import "server-only";
import { db } from "@/lib/db";

/**
 * Records every call we make to a sandbox and every webhook we receive.
 * This table is the evidence trail for the integrations, and powers the
 * broker's Integration log page.
 */
export async function logIntegrationEvent(event: {
  provider: "stripe" | "docusign";
  direction: "OUTBOUND" | "INBOUND";
  eventType: string;
  externalId?: string | null;
  policyId?: string | null;
  payload: unknown;
}) {
  try {
    await db.integrationEvent.create({
      data: {
        provider: event.provider,
        direction: event.direction,
        eventType: event.eventType,
        externalId: event.externalId ?? null,
        policyId: event.policyId ?? null,
        // Round-trip through JSON so only plain data is stored.
        payload: JSON.parse(JSON.stringify(event.payload ?? null)) ?? {},
      },
    });
  } catch (error) {
    // Logging must never break a payment.
    console.error("Failed to log integration event", error);
  }
}
