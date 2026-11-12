"use client";

import { useState, useTransition } from "react";
import { issueFromApplicationAction, withdrawApplicationAction } from "@/app/broker/actions";
import { ButtonLabel, primaryButton, secondaryButton } from "@/components/ui";

export function ApplicationActions({
  applicationId,
  customerId,
  status,
}: {
  applicationId: string;
  customerId: string;
  status: "AWAITING_SIGNATURE" | "SIGNED";
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (action: () => Promise<{ error?: string } | undefined>) =>
    startTransition(async () => setError((await action())?.error ?? null));

  return (
    <div className="text-right">
      {status === "SIGNED" ? (
        <button
          type="button"
          disabled={pending}
          className={primaryButton}
          onClick={() => run(() => issueFromApplicationAction(applicationId))}
        >
          <ButtonLabel pending={pending}>Issue policy</ButtonLabel>
        </button>
      ) : (
        <button
          type="button"
          disabled={pending}
          className={secondaryButton}
          onClick={() => run(() => withdrawApplicationAction(applicationId, customerId))}
        >
          <ButtonLabel pending={pending}>Withdraw</ButtonLabel>
        </button>
      )}
      {error && <p className="mt-1 max-w-xs text-xs text-red-700">{error}</p>}
    </div>
  );
}
