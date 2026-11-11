import type Stripe from "stripe";
import { logIntegrationEvent } from "@/lib/integrations/log";
import { stripe } from "@/lib/integrations/stripe";
import { recordPaymentIntent, recordRefund } from "@/lib/policies/payments";

/**
 * Stripe tells us here when a payment or refund changes state. This, not the
 * browser, is what moves a payment from pending to succeeded or failed.
 */
export async function POST(request: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const signature = request.headers.get("stripe-signature");
  if (!secret || !signature) return new Response("Webhook not configured", { status: 400 });

  let event: Stripe.Event;
  try {
    // Verifies the request really came from Stripe. Needs the raw body.
    event = await stripe().webhooks.constructEventAsync(await request.text(), signature, secret);
  } catch {
    return new Response("Invalid signature", { status: 400 });
  }

  const object = event.data.object as { id?: string; metadata?: Record<string, string> | null };
  await logIntegrationEvent({
    provider: "stripe",
    direction: "INBOUND",
    eventType: event.type,
    externalId: object.id ?? event.id,
    policyId: object.metadata?.policyId ?? null,
    payload: { eventId: event.id, created: event.created, object: summarise(event) },
  });

  switch (event.type) {
    case "payment_intent.succeeded":
    case "payment_intent.payment_failed":
    case "payment_intent.processing":
    case "payment_intent.canceled": {
      // Re-read from Stripe so out-of-order deliveries can't move a payment backwards.
      const intent = await stripe().paymentIntents.retrieve(event.data.object.id, { expand: ["payment_method"] });
      await recordPaymentIntent(intent);
      break;
    }
    case "refund.created":
    case "refund.updated":
    case "refund.failed":
      await recordRefund(await stripe().refunds.retrieve(event.data.object.id));
      break;
  }

  return Response.json({ received: true });
}

/** The parts of the event worth keeping in our log. */
function summarise(event: Stripe.Event) {
  const o = event.data.object as unknown as Record<string, unknown>;
  const keep = ["id", "object", "amount", "amount_received", "currency", "status", "payment_intent", "metadata", "failure_reason"];
  const out: Record<string, unknown> = {};
  for (const k of keep) if (k in o) out[k] = o[k];
  const error = o.last_payment_error as { code?: string; message?: string } | undefined;
  if (error) out.last_payment_error = { code: error.code, message: error.message };
  return out;
}
