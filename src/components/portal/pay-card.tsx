"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { loadStripe } from "@stripe/stripe-js";
import { refreshPaymentsAction, startPaymentAction } from "@/app/portal/actions";
import { ButtonLabel, Card, primaryButton, secondaryButton } from "@/components/ui";
import { formatDate, formatUSD, isBelowMinimumPayment, MIN_PAYMENT_CENTS, signedUSD } from "@/lib/engine";
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
  statementLines,
  reasons,
}: {
  policyId: string;
  amountDueCents: number;
  /** Set when the term hasn't started yet, so the premium isn't due until then. */
  dueDate?: string | null;
  hasPendingPayment: boolean;
  /** How many lines the statement on this page has. */
  statementLines: number;
  /** The changes this amount comes from, oldest first, so the customer isn't asked to pay without being told why. */
  reasons: DueReason[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // The payment Stripe is holding for this policy, and the amount it will collect.
  const [checkout, setCheckout] = useState<{ clientSecret: string; amountCents: number; quotedCents: number } | null>(null);
  const clientSecret = checkout?.clientSecret ?? null;
  const [error, setError] = useState<string | null>(null);
  // Set when checkout found that nothing is due after all, because an earlier payment went through.
  // `statementLines` is how long the statement was once that payment was on it.
  const [paid, setPaid] = useState<{ message: string; statementLines: number } | null>(null);
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

  // Checkout found the policy already paid. Say so in place of the Pay button: straight away,
  // while this page still shows the old amount, and after it has refreshed to show nothing due.
  // The notice is tied to the statement, not to the amount or to what this page has displayed.
  // While the page's statement is shorter than the one checkout settled, the page is behind and
  // its amount is out of date. Once it has caught up, an amount due is real, whether or not the
  // page ever showed zero in between, so the Pay button is shown.
  if (paid && (amountDueCents <= 0 || statementLines < paid.statementLines)) {
    return (
      <Card id="pay" title="Paid">
        <p className="px-5 py-4 text-sm text-green-800" data-testid="already-paid">
          {paid.message}
        </p>
      </Card>
    );
  }
  if (amountDueCents <= 0) return null;

  // Stripe can't collect less than $0.50, so no payment is offered. The amount stays on the statement.
  if (isBelowMinimumPayment(amountDueCents)) {
    return (
      <Card id="pay" title="Nothing to pay right now">
        <p className="px-5 py-4 text-sm text-slate-700" data-testid="pay-below-minimum">
          {formatUSD(amountDueCents)} is due, which is less than {formatUSD(MIN_PAYMENT_CENTS)}, the smallest amount
          that can be collected by card or bank account. You don&apos;t need to do anything. It stays on your statement
          and will be added to your next payment.
        </p>
      </Card>
    );
  }

  /** `quoted` is the amount the customer was last shown: on the Pay button, or on a form that has since been closed. */
  const begin = (quoted: number = amountDueCents) =>
    startTransition(async () => {
      setError(null);
      const result = await startPaymentAction(policyId);
      if (!result.ok) {
        // The server may have recorded a payment, or found one in progress. Show the page as it is now.
        if (result.paid) setPaid({ message: result.message, statementLines: result.statementLines });
        else setError(result.error);
        router.refresh();
        return;
      }
      setPaid(null);
      // The amount comes from the server, not from this page, which may have been open a while.
      setCheckout({ clientSecret: result.clientSecret, amountCents: result.amountCents, quotedCents: quoted });
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
              <button type="button" onClick={() => begin()} disabled={pending || !stripePromise} className={primaryButton}>
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
          // Keyed by the payment, so a replacement payment gets a fresh form.
          <Elements key={checkout.clientSecret} stripe={stripePromise} options={{ clientSecret: checkout.clientSecret }}>
            <PaymentForm
              policyId={policyId}
              restarting={pending}
              onClosed={(shown) => begin(shown)}
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
  restarting,
  onClosed,
  onDone,
  onCancel,
}: {
  policyId: string;
  /** True while a replacement payment is being started. */
  restarting: boolean;
  /** Called when Stripe says this payment has been closed, with the amount this form was showing. */
  onClosed: (shownCents: number) => void;
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
    if (current.paymentIntent.status === "canceled") {
      // The amount due changed while this form was open, and this payment was closed. Nothing
      // is charged. A new payment is started for the amount due now, and the customer is
      // shown both figures and asked to agree before paying.
      setSubmitting(false);
      onClosed(amount);
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
        <button type="submit" disabled={!stripe || submitting || restarting || (changed && !agreed)} className={primaryButton}>
          <ButtonLabel pending={submitting || restarting}>{`Pay ${formatUSD(amount)}`}</ButtonLabel>
        </button>
        <button type="button" onClick={onCancel} disabled={submitting} className={secondaryButton}>
          Cancel
        </button>
      </div>
    </form>
  );
}
