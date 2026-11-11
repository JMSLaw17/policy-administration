"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { applyChangeAction, previewChangeAction } from "@/app/broker/actions";
import { dangerButton, primaryButton, secondaryButton } from "@/components/ui";
import { formatUSD, formulaFor, periodFor, signedUSD } from "@/lib/engine";
import type { ChangePreview, ChangeRequest, PlannedLine } from "@/lib/policies/service";

/**
 * The two-step flow every money-affecting broker action uses:
 * preview what it will do to the statement, then confirm.
 */
export function useChangeFlow(policyId: string) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [request, setRequest] = useState<ChangeRequest | null>(null);
  const [preview, setPreview] = useState<ChangePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const reset = () => {
    setRequest(null);
    setPreview(null);
    setError(null);
  };

  const runPreview = (next: ChangeRequest) =>
    startTransition(async () => {
      setDone(false);
      setNotice(null);
      const result = await previewChangeAction(policyId, next);
      if (result.ok) {
        setRequest(next);
        setPreview(result.preview);
        setError(null);
      } else {
        setPreview(null);
        setError(result.error);
      }
    });

  const confirm = (onSaved?: () => void) =>
    startTransition(async () => {
      if (!request) return;
      const result = await applyChangeAction(policyId, request);
      if (result.ok) {
        reset();
        setDone(true);
        setNotice(result.notice ?? null);
        onSaved?.();
        router.refresh();
      } else {
        setPreview(null);
        setError(result.error);
      }
    });

  return { pending, preview, error, done, notice, runPreview, confirm, reset };
}

export function PreviewPanel({
  preview,
  pending,
  onConfirm,
  onBack,
  confirmLabel,
  danger,
}: {
  preview: ChangePreview;
  pending: boolean;
  onConfirm: () => void;
  onBack: () => void;
  confirmLabel: string;
  danger?: boolean;
}) {
  const after = preview.balanceAfterCents;
  return (
    <div className="mt-4 rounded-md border border-indigo-200 bg-indigo-50/50 p-4" data-testid="preview">
      <h3 className="text-sm font-semibold text-slate-900">What this will do to the statement</h3>
      <table className="mt-2 w-full text-sm">
        <tbody className="divide-y divide-indigo-100">
          {preview.reversals.map((l, i) => (
            <PreviewRow key={`r${i}`} line={l} />
          ))}
          {preview.postings.map((l, i) => (
            <PreviewRow key={`p${i}`} line={l} />
          ))}
          {preview.reversals.length + preview.postings.length === 0 && (
            <tr>
              <td className="py-2 text-slate-600">No premium lines. Nothing is owed or credited.</td>
            </tr>
          )}
        </tbody>
      </table>
      <dl className="mt-3 grid grid-cols-[1fr_auto] gap-x-6 gap-y-1 border-t border-indigo-200 pt-3 text-sm">
        <dt className="text-slate-600">Balance now</dt>
        <dd className="text-right tabular-nums">{formatUSD(preview.balanceBeforeCents)}</dd>
        <dt className="text-slate-600">Change</dt>
        <dd className="text-right tabular-nums">{signedUSD(preview.netChangeCents)}</dd>
        <dt className="font-semibold text-slate-900">
          {after > 0 ? "New amount due" : after < 0 ? "Credit to refund to the customer" : "New balance"}
        </dt>
        <dd className="text-right font-semibold tabular-nums text-slate-900" data-testid="preview-after">
          {formatUSD(Math.abs(after))}
        </dd>
      </dl>
      <div className="mt-4 flex gap-2">
        <button type="button" disabled={pending} onClick={onConfirm} className={danger ? dangerButton : primaryButton}>
          {pending ? "Saving…" : confirmLabel}
        </button>
        <button type="button" disabled={pending} onClick={onBack} className={secondaryButton}>
          Back
        </button>
      </div>
    </div>
  );
}

function PreviewRow({ line }: { line: PlannedLine }) {
  return (
    <tr>
      <td className="py-2 pr-4">
        <p className="text-slate-900">{line.description}</p>
        <p className="text-xs text-slate-500">
          {periodFor({ ...line.calc, coverageCode: line.coverageCode })}
          {" · "}
          <span className="font-mono">{formulaFor({ ...line.calc, amountCents: line.amountCents })}</span>
        </p>
      </td>
      <td className="py-2 text-right align-top font-medium tabular-nums whitespace-nowrap">
        {signedUSD(line.amountCents)}
      </td>
    </tr>
  );
}

export function FormError({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
      {error}
    </p>
  );
}

export function SavedNotice({ done, notice, label }: { done: boolean; notice: string | null; label: string }) {
  if (!done) return null;
  return (
    <p className="mt-3 rounded-md bg-green-50 px-3 py-2 text-sm text-green-800" data-testid="saved-notice">
      {label} {notice}
    </p>
  );
}
