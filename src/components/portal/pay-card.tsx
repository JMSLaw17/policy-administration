"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { loadStripe } from "@stripe/stripe-js";
import { refreshPaymentsAction, startPaymentAction } from "@/app/portal/actions";
import { Card, primaryButton, secondaryButton } from "@/components/ui";
import { formatDate, formatUSD } from "@/lib/engine";

const publishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
const stripePromise = publishableKey ? loadStripe(publishableKey) : null;

export function PayCard({
  policyId,
  amountDueCents,
  dueDate,
  hasPendingPayment,
}: {
  policyId: string;
  amountDueCents: number;
  /** Set when the term hasn't started yet, so the premium isn't due until then. */
  dueDate?: string | null;
  hasPendingPayment: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);

  // While Stripe is still working on a payment, keep checking until it settles.
  const waiting = hasPendingPayment && !clientSecret;
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => {
      refreshPaymentsAction(policyId).then(() => router.refresh());
    }, 4000);
    return () => clearInterval(timer);
  }, [waiting, policyId, router]);

  if (amountDueCents <= 0) return null;

  const begin = () =>
    startTransition(async () => {
      setError(null);
      const result = await startPaymentAction(policyId);
      if (result.ok) setClientSecret(result.clientSecret);
      else setError(result.error);
    });

  const finished = async () => {
    setClientSecret(null);
    setProcessing(true);
    await refreshPaymentsAction(policyId);
    router.refresh();
    setProcessing(false);
  };

  return (
    <Card
      id="pay"
      title={`Pay ${formatUSD(amountDueCents)}`}
      description={
        dueDate
          ? `Not due until ${formatDate(dueDate)}, when the term starts. You can pay early. Payments run through Stripe in test mode, so no real money moves.`
          : "Payments run through Stripe in test mode. No real money moves."
      }
    >
      <div className="px-5 py-4">
        {!clientSecret && (
          <>
            {waiting || processing ? (
              <p className="text-sm text-amber-800" data-testid="payment-pending">
                Your payment is pending. This page updates as soon as Stripe confirms it.
              </p>
            ) : (
              <button type="button" onClick={begin} disabled={pending || !stripePromise} className={primaryButton}>
                {pending ? "Starting…" : `Pay ${formatUSD(amountDueCents)} now`}
              </button>
            )}
            {!stripePromise && (
              <p className="mt-2 text-sm text-slate-500">Payments aren&apos;t set up in this environment yet.</p>
            )}
          </>
        )}
        {error && (
          <p role="alert" className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}
        {clientSecret && stripePromise && (
          <Elements stripe={stripePromise} options={{ clientSecret }}>
            <PaymentForm
              policyId={policyId}
              amountCents={amountDueCents}
              onDone={finished}
              onCancel={() => setClientSecret(null)}
            />
          </Elements>
        )}
        <p className="mt-4 text-xs text-slate-500">
          Test cards: 4242 4242 4242 4242 succeeds, 4000 0000 0000 0002 is declined. Use any future expiry, any
          CVC, and any ZIP.
        </p>
      </div>
    </Card>
  );
}

function PaymentForm({
  policyId,
  amountCents,
  onDone,
  onCancel,
}: {
  policyId: string;
  amountCents: number;
  onDone: () => void;
  onCancel: () => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!stripe || !elements) return;
    setSubmitting(true);
    setError(null);
    const result = await stripe.confirmPayment({
      elements,
      confirmParams: { return_url: `${window.location.origin}/portal/policies/${policyId}` },
      redirect: "if_required",
    });
    setSubmitting(false);
    if (result.error) {
      // Shown to the customer straight away; Stripe's webhook records the failure on our side.
      setError(result.error.message ?? "The payment didn't go through.");
      await refreshPaymentsAction(policyId);
      return;
    }
    onDone();
  };

  return (
    <form onSubmit={submit} className="max-w-md">
      <PaymentElement />
      {error && (
        <p role="alert" className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700" data-testid="payment-error">
          {error}
        </p>
      )}
      <div className="mt-4 flex gap-2">
        <button type="submit" disabled={!stripe || submitting} className={primaryButton}>
          {submitting ? "Paying…" : `Pay ${formatUSD(amountCents)}`}
        </button>
        <button type="button" onClick={onCancel} disabled={submitting} className={secondaryButton}>
          Cancel
        </button>
      </div>
    </form>
  );
}
