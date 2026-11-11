"use client";

import { useState, useTransition, type FormEvent } from "react";
import { decideClaimAction, fileClaimAction, payClaimAction, type ClaimFormState } from "@/app/claim-actions";
import { dangerButton, inputClass, primaryButton, secondaryButton } from "@/components/ui";
import { COVERAGES, formatUSD } from "@/lib/engine";

export function FileClaimForm({
  policyId,
  coverageCodes,
  today,
}: {
  policyId: string;
  /** Coverages that have been on this policy at some point. */
  coverageCodes: string[];
  today: string;
}) {
  const [state, setState] = useState<ClaimFormState>();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);

  // Submitted by hand rather than as a form action, so the fields keep what
  // was typed if the claim is rejected.
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(async () => {
      const result = await fileClaimAction(undefined, formData);
      setState(result);
      if (result?.saved) setOpen(false);
    });
  };
  if (!open) {
    return (
      <div className="px-5 py-4">
        {state?.saved && <p className="mb-3 text-sm text-green-700">{state.saved}</p>}
        <button type="button" onClick={() => setOpen(true)} className={secondaryButton}>
          File a claim
        </button>
      </div>
    );
  }
  return (
    <form onSubmit={submit} className="grid gap-4 border-t border-slate-200 px-5 py-4 sm:grid-cols-3">
      <input type="hidden" name="policyId" value={policyId} />
      <label className="block">
        <span className="text-sm font-medium text-slate-700">Coverage</span>
        <select name="coverageCode" className={inputClass} required>
          {COVERAGES.filter((c) => coverageCodes.includes(c.code)).map((c) => (
            <option key={c.code} value={c.code}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="text-sm font-medium text-slate-700">Date of loss</span>
        <input type="date" name="lossDate" max={today} required className={inputClass} />
      </label>
      <label className="block">
        <span className="text-sm font-medium text-slate-700">Amount of the loss ($)</span>
        <input name="claimed" inputMode="decimal" placeholder="4,000" required className={inputClass} />
      </label>
      <label className="block sm:col-span-3">
        <span className="text-sm font-medium text-slate-700">What happened?</span>
        <textarea name="description" rows={2} required className={inputClass} />
      </label>
      {state?.error && (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 sm:col-span-3">
          {state.error}
        </p>
      )}
      <div className="flex gap-2 sm:col-span-3">
        <button type="submit" disabled={pending} className={primaryButton}>
          {pending ? "Filing…" : "File claim"}
        </button>
        <button type="button" onClick={() => setOpen(false)} className={secondaryButton}>
          Close
        </button>
      </div>
    </form>
  );
}

export function DecideClaimForm({
  claimId,
  claimedCents,
  deductibleCents,
}: {
  claimId: string;
  claimedCents: number;
  deductibleCents: number;
}) {
  const [state, setState] = useState<ClaimFormState>();
  const [pending, startTransition] = useTransition();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // Include the button that was pressed, which carries the decision.
    const formData = new FormData(event.currentTarget, (event.nativeEvent as SubmitEvent).submitter);
    startTransition(async () => setState(await decideClaimAction(undefined, formData)));
  };
  return (
    <form onSubmit={submit} className="mt-3 rounded-md border border-slate-200 bg-slate-50 p-3">
      <input type="hidden" name="claimId" value={claimId} />
      <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
        <label className="block">
          <span className="text-sm font-medium text-slate-700">Approved loss ($)</span>
          <input
            name="approved"
            inputMode="decimal"
            defaultValue={(claimedCents / 100).toFixed(2)}
            className={inputClass}
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-slate-700">Note (required to deny)</span>
          <input name="note" className={inputClass} />
        </label>
      </div>
      <p className="mt-2 text-xs text-slate-500">
        The payout is the approved loss less the {formatUSD(deductibleCents)} deductible, capped at the coverage
        limit.
      </p>
      {state?.error && (
        <p role="alert" className="mt-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {state.error}
        </p>
      )}
      <div className="mt-3 flex gap-2">
        <button type="submit" name="decision" value="APPROVE" disabled={pending} className={primaryButton}>
          Approve
        </button>
        <button type="submit" name="decision" value="DENY" disabled={pending} className={dangerButton}>
          Deny
        </button>
      </div>
    </form>
  );
}

export function PayClaimButton({ claimId, payoutCents }: { claimId: string; payoutCents: number }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="mt-3">
      <button
        type="button"
        disabled={pending}
        className={primaryButton}
        onClick={() => startTransition(async () => setError((await payClaimAction(claimId))?.error ?? null))}
      >
        {pending ? "Recording…" : `Record payment of ${formatUSD(payoutCents)}`}
      </button>
      {error && <p className="mt-1 text-xs text-red-700">{error}</p>}
    </div>
  );
}
