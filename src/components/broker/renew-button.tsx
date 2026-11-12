"use client";

import { useState, useTransition } from "react";
import { renewPolicyAction } from "@/app/broker/actions";
import { ButtonLabel, primaryButton } from "@/components/ui";

/** `previewed` identifies the renewal shown beside this button. The server refuses to create a different one. */
export function RenewButton({ policyId, previewed }: { policyId: string; previewed: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div>
      <button
        type="button"
        disabled={pending}
        className={primaryButton}
        onClick={() => startTransition(async () => setError((await renewPolicyAction(policyId, previewed))?.error ?? null))}
      >
        <ButtonLabel pending={pending}>Renew policy</ButtonLabel>
      </button>
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-700" data-testid="renew-error">
          {error}
        </p>
      )}
    </div>
  );
}
