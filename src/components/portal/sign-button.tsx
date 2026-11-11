"use client";

import { useState, useTransition } from "react";
import { startSigningAction } from "@/app/portal/actions";
import { primaryButton } from "@/components/ui";

export function SignButton({ applicationId }: { applicationId: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="text-right">
      <button
        type="button"
        disabled={pending}
        className={primaryButton}
        onClick={() => startTransition(async () => setError((await startSigningAction(applicationId))?.error ?? null))}
      >
        {pending ? "Opening DocuSign…" : "Review and sign"}
      </button>
      {error && <p className="mt-1 max-w-xs text-xs text-red-700">{error}</p>}
    </div>
  );
}
