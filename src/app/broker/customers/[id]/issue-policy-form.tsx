"use client";

import { useActionState, useState } from "react";
import { issuePolicyAction, type FormState } from "@/app/broker/actions";
import { inputClass, primaryButton } from "@/components/ui";
import { addOneYear, COVERAGES, formatDate, formatUSD, isISODate } from "@/lib/engine";

export function IssuePolicyForm({
  customerId,
  today,
  requiresSignature,
}: {
  customerId: string;
  today: string;
  /** With DocuSign set up, the policyholder signs an application first. */
  requiresSignature: boolean;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(issuePolicyAction, undefined);
  const [startDate, setStartDate] = useState(today);
  const [selected, setSelected] = useState(COVERAGES.filter((c) => c.required).map((c) => c.code));

  const total = COVERAGES.filter((c) => selected.includes(c.code)).reduce((s, c) => s + c.annualPremiumCents, 0);
  const endDate = isISODate(startDate) ? addOneYear(startDate) : null;

  return (
    <form action={action} className="px-5 py-4">
      <input type="hidden" name="customerId" value={customerId} />
      <div className="grid gap-6 sm:grid-cols-[14rem_1fr]">
        <div className="space-y-4">
          <label className="block">
            <span className="text-sm font-medium text-slate-700">Start date</span>
            <input
              type="date"
              name="startDate"
              required
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className={inputClass}
            />
          </label>
          <div>
            <span className="text-sm font-medium text-slate-700">End date</span>
            <p className="mt-1 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
              {endDate ? formatDate(endDate) : "…"}
            </p>
            <p className="mt-1 text-xs text-slate-500">Every policy runs for 12 months.</p>
          </div>
        </div>
        <fieldset>
          <legend className="text-sm font-medium text-slate-700">Coverages</legend>
          <div className="mt-1 divide-y divide-slate-100 rounded-md border border-slate-200">
            {COVERAGES.map((c) => (
              <label key={c.code} className="flex items-start gap-3 px-3 py-2.5 text-sm">
                <input
                  type="checkbox"
                  name="coverages"
                  value={c.code}
                  checked={selected.includes(c.code)}
                  // A disabled checkbox isn't submitted, so required ones are locked with onChange instead.
                  onChange={() =>
                    !c.required &&
                    setSelected((s) => (s.includes(c.code) ? s.filter((x) => x !== c.code) : [...s, c.code]))
                  }
                  className="mt-0.5 size-4 rounded border-slate-300"
                />
                <span className="flex-1">
                  <span className="font-medium text-slate-900">{c.name}</span>
                  {c.required && <span className="ml-2 text-xs text-slate-400">required</span>}
                  <span className="block text-slate-500">{c.description}</span>
                </span>
                <span className="tabular-nums text-slate-700">{formatUSD(c.annualPremiumCents)}/yr</span>
              </label>
            ))}
          </div>
          <p className="mt-3 flex justify-between text-sm font-semibold text-slate-900">
            <span>Premium for the full term</span>
            <span className="tabular-nums" data-testid="issue-total">
              {formatUSD(total)}
            </span>
          </p>
        </fieldset>
      </div>
      {state?.error && (
        <p role="alert" className="mt-3 text-sm text-red-600">
          {state.error}
        </p>
      )}
      {state?.saved && <p className="mt-3 text-sm text-green-700">{state.saved}</p>}
      <button type="submit" disabled={pending} className={`${primaryButton} mt-4`}>
        {requiresSignature
          ? pending
            ? "Sending…"
            : "Send application for signature"
          : pending
            ? "Issuing…"
            : "Issue policy"}
      </button>
    </form>
  );
}
