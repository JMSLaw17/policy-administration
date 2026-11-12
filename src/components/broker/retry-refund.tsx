"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { retryRefundAction } from "@/app/broker/actions";
import { ButtonLabel, secondaryButton } from "@/components/ui";

export function RetryRefundButton({ policyId }: { policyId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <div className="text-right">
      <button
        type="button"
        disabled={pending}
        className={secondaryButton}
        onClick={() =>
          startTransition(async () => {
            const result = await retryRefundAction(policyId);
            setNotice(result.notice ?? "Nothing to refund.");
            router.refresh();
          })
        }
      >
        <ButtonLabel pending={pending}>Refund credit</ButtonLabel>
      </button>
      {notice && <p className="mt-1 max-w-xs text-xs text-slate-600">{notice}</p>}
    </div>
  );
}
