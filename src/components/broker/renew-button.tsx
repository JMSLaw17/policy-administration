"use client";

import { useState, useTransition } from "react";
import { renewPolicyAction } from "@/app/broker/actions";
import { ButtonLabel, primaryButton } from "@/components/ui";

export function RenewButton({ policyId }: { policyId: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div>
      <button
        type="button"
        disabled={pending}
        className={primaryButton}
        onClick={() => startTransition(async () => setError((await renewPolicyAction(policyId))?.error ?? null))}
      >
        <ButtonLabel pending={pending}>Renew policy</ButtonLabel>
      </button>
      {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
    </div>
  );
}
