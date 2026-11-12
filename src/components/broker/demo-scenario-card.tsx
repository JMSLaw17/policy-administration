"use client";

import { useState, useTransition } from "react";
import { loadDemoScenarioAction } from "@/app/broker/actions";
import { ButtonLabel, secondaryButton } from "@/components/ui";

/** One click to the starting point of the scenario in the brief. */
export function DemoScenarioCard() {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="mt-6 flex flex-wrap items-center justify-between gap-4 rounded-lg border border-indigo-200 bg-indigo-50/60 px-5 py-4">
      <div className="max-w-3xl text-sm text-slate-700">
        <p className="font-medium text-slate-900">Try the correction scenario</p>
        <p className="mt-0.5">
          Creates a new fictional customer whose policy is paid, with Cyber Liability added three weeks ago, also
          paid, but recorded as starting a week later than it really did. You land on the policy, ready to correct
          the date. It takes a few seconds because it makes two real Stripe test payments.
        </p>
        {error && (
          <p role="alert" className="mt-2 text-red-700">
            {error}
          </p>
        )}
      </div>
      <button
        type="button"
        disabled={pending}
        className={secondaryButton}
        onClick={() => startTransition(async () => setError((await loadDemoScenarioAction())?.error ?? null))}
      >
        <ButtonLabel pending={pending}>Load demo scenario</ButtonLabel>
      </button>
    </div>
  );
}
