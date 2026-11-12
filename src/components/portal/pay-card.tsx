"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { loadStripe } from "@stripe/stripe-js";
import { refreshPaymentsAction, startPaymentAction } from "@/app/portal/actions";
import { ButtonLabel, Card, primaryButton, secondaryButton } from "@/components/ui";
import { formatDate, formatUSD, signedUSD } from "@/lib/engine";
import type { DueReason } from "@/lib/policies/view";

const shortDate = (iso: string) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(iso));

const publishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
const stripePromise = publishableKey ? loadStripe(publishableKey) : null;

export function PayCard({
  policyId,
  amountDueCents,
  dueDate,
  hasPendingPayment,
  reasons,
}: {
  policyId: string;
  amountDueCents: number;
  /** Set when the term hasn't started yet, so the premium isn't due until then. */
  dueDate?: string | null;
  hasPendingPayment: boolean;
  /** The changes this amount comes from, oldest first, so the customer isn't asked to pay without being told why. */
  reasons: DueReason[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // The payment Stripe is holding for this policy, and the amount it will collect.
  const [checkout, setCheckout] = useState<{ clientSecret: string; amountCents: number; quotedCents: number } | null>(null);
  const clientSecret = checkout?.clientSecret ?? null;
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
      if (!result.ok) return setError(result.error);
      // The amount comes from the server, not from this page, which may have been open a while.
      // `quotedCents` is what the button the customer just pressed said.
      setCheckout({ clientSecret: result.clientSecret, amountCents: result.amountCents, quotedCents: amountDueCents });
      if (result.amountCents !== amountDueCents) router.refresh();
    });

  const finished = async () => {
    setCheckout(null);
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
        {reasons.length > 0 && (
          <div className="mb-4 rounded-md bg-indigo-50 px-3 py-2.5 text-sm text-slate-800" data-testid="due-reasons">
            <p className="font-medium">Why this is due</p>
            <ul className="mt-1.5 space-y-2">
              {reasons.map((reason) => (
                <li key={reason.seq ?? `line-${reason.line}`} className="flex items-start justify-between gap-6">
                  <span>
                    <a
                      className="font-medium text-indigo-700 underline"
                      href={reason.seq ? `#history-${reason.seq}` : `#line-${reason.line}`}
                    >
                      {reason.title}
                    </a>
                    , {shortDate(reason.recordedAt)}. {reason.text}
                    {reason.reason && <span className="block text-slate-600">Reason: {reason.reason}</span>}
                  </span>
                  <span className="font-medium tabular-nums whitespace-nowrap">{signedUSD(reason.netCents)}</span>
                </li>
              ))}
            </ul>
            {/* With more than one row, show that they come to the amount on the button. */}
            {reasons.length > 1 && (
              <p className="mt-2 flex justify-between gap-6 border-t border-indigo-200 pt-2 font-medium" data-testid="due-total">
                <span>Amount due</span>
                <span className="tabular-nums">{formatUSD(reasons.reduce((sum, r) => sum + r.netCents, 0))}</span>
              </p>
            )}
          </div>
        )}
        {!clientSecret && (
          <>
            {waiting || processing ? (
              <p className="text-sm text-amber-800" data-testid="payment-pending">
                Your payment is pending. This page updates as soon as Stripe confirms it.
              </p>
            ) : (
              <button type="button" onClick={begin} disabled={pending || !stripePromise} className={primaryButton}>
                <ButtonLabel pending={pending}>{`Pay ${formatUSD(amountDueCents)} now`}</ButtonLabel>
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
        {checkout && stripePromise && (
          <Elements stripe={stripePromise} options={{ clientSecret: checkout.clientSecret }}>
            <PaymentForm
              policyId={policyId}
              clientSecret={checkout.clientSecret}
              amountCents={checkout.amountCents}
              quotedCents={checkout.quotedCents}
              onDone={finished}
              onCancel={() => setCheckout(null)}
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

/**
 * Stripe's form and the Pay button. The button always shows the amount held
 * on the Stripe payment itself, which is what will be collected. If that
 * differs from the amount the customer was last shown, they are told, and
 * have to tick a box agreeing to the new amount before they can pay.
 */
function PaymentForm({
  policyId,
  clientSecret,
  amountCents,
  quotedCents,
  onDone,
  onCancel,
}: {
  policyId: string;
  clientSecret: string;
  /** The amount on the Stripe payment when the form was opened. */
  amountCents: number;
  /** The amount on the button the customer pressed to open the form. */
  quotedCents: number;
  onDone: () => void;
  onCancel: () => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // `amount` is what Stripe will collect. `shown` is the last amount the customer saw and accepted.
  const [amount, setAmount] = useState(amountCents);
  const [shown, setShown] = useState(quotedCents);
  const [agreed, setAgreed] = useState(false);
  const changed = amount !== shown;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!stripe || !elements) return;
    setSubmitting(true);
    setError(null);
    // The amount can be lowered while this form is open, after a broker's change.
    // Ask Stripe what it holds now, and never charge an amount that wasn't on the button.
    const current = await stripe.retrievePaymentIntent(clientSecret);
    if (!current.paymentIntent) {
      // The amount couldn't be checked, so the payment isn't sent.
      setSubmitting(false);
      setError("We couldn't check the amount with Stripe, so nothing was charged. Please try again.");
      return;
    }
    if (current.paymentIntent.amount !== amount) {
      await elements.fetchUpdates();
      setShown(amount);
      setAmount(current.paymentIntent.amount);
      setAgreed(false);
      setSubmitting(false);
      router.refresh();
      return;
    }
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
      {/* Link is Stripe's saved-details wallet. Off, so the form offers only card and bank account. */}
      <PaymentElement options={{ wallets: { link: "never" } }} />
      {changed && (
        <div className="mt-3 rounded-md bg-amber-50 px-3 py-2.5 text-sm text-amber-900" role="alert" data-testid="amount-changed">
          <p>
            <span className="font-medium">The amount due has changed.</span> It was {formatUSD(shown)} and is now{" "}
            {formatUSD(amount)}, because your policy was changed while this page was open. The reason is shown above
            and in your policy history.
          </p>
          <label className="mt-2 flex items-center gap-2 font-medium">
            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} disabled={submitting} />
            Pay the new amount, {formatUSD(amount)}
          </label>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700" data-testid="payment-error">
          {error}
        </p>
      )}
      <div className="mt-4 flex gap-2">
        <button type="submit" disabled={!stripe || submitting || (changed && !agreed)} className={primaryButton}>
          <ButtonLabel pending={submitting}>{`Pay ${formatUSD(amount)}`}</ButtonLabel>
        </button>
        <button type="button" onClick={onCancel} disabled={submitting} className={secondaryButton}>
          Cancel
        </button>
      </div>
    </form>
  );
}
