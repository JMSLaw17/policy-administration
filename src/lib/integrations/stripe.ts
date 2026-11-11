import "server-only";
import Stripe from "stripe";

let client: Stripe | null = null;

/** The Stripe client. Refuses to run with anything but a test-mode key. */
export function stripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new StripeNotConfiguredError();
  if (!key.startsWith("sk_test_") && !key.startsWith("rk_test_")) {
    throw new Error("This demo only runs against Stripe test mode. Use a test key.");
  }
  client ??= new Stripe(key);
  return client;
}

export class StripeNotConfiguredError extends Error {
  constructor() {
    super("Stripe isn't set up yet. Add STRIPE_SECRET_KEY to the environment.");
    this.name = "StripeNotConfiguredError";
  }
}

export const isStripeConfigured = () =>
  Boolean(process.env.STRIPE_SECRET_KEY && process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY);
