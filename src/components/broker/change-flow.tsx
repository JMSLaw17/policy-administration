"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { applyChangeAction, previewChangeAction } from "@/app/broker/actions";
import { ButtonLabel, dangerButton, inputClass, primaryButton, secondaryButton } from "@/components/ui";
import { formatDate, formatUSD, formulaFor, periodFor, signedUSD } from "@/lib/engine";
import type {
  ChangePreview,
  ChangeRequest,
  FollowStep,
  Gap,
  PlannedLine,
  RenewalChoice,
} from "@/lib/policies/service";

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
  /** Set when a confirmation was refused because the figures had moved since the preview. */
  const [changed, setChanged] = useState<string | null>(null);

  // The reason as it stands on screen right now. It can be typed at any time: before the
  // preview, while the preview is loading, or after it. Confirmation always sends this one,
  // so the history records the reason the broker finished with, not an earlier draft.
  const latestReason = useRef<string | undefined>(undefined);

  const reset = () => {
    setRequest(null);
    setPreview(null);
    setError(null);
    setChanged(null);
  };

  const runPreview = (next: ChangeRequest) =>
    startTransition(async () => {
      setDone(false);
      setNotice(null);
      setChanged(null);
      latestReason.current = next.reason;
      const result = await previewChangeAction(policyId, next);
      if (result.ok) {
        // The reason may have been edited while the preview was loading.
        setRequest({ ...next, reason: latestReason.current });
        setPreview(result.preview);
        setError(null);
      } else {
        setPreview(null);
        setError(result.error);
      }
    });

  const confirm = (onSaved?: () => void) =>
    startTransition(async () => {
      if (!request || !preview) return;
      // The preview's fingerprint goes with the confirmation, so what is saved is what was shown.
      const result = await applyChangeAction(policyId, { ...request, reason: latestReason.current }, preview.fingerprint);
      if (result.ok) {
        reset();
        setDone(true);
        setNotice(result.notice ?? null);
        onSaved?.();
        router.refresh();
      } else if (result.preview) {
        // Nothing was saved. Show the new figures and ask again.
        setPreview(result.preview);
        setChanged(result.error);
        setError(null);
        router.refresh();
      } else {
        setPreview(null);
        setError(result.error);
      }
    });

  /** Switches what happens to the renewal, and recalculates the preview for that choice. */
  const chooseRenewal = (choice: RenewalChoice) => {
    if (request) runPreview({ ...request, reason: latestReason.current, renewal: choice });
  };

  /** The reason can still be typed after the preview, because a gap can only be saved with one. */
  const setReason = (reason: string) => {
    latestReason.current = reason;
    setRequest((r) => (r ? { ...r, reason } : r));
  };

  return { pending, preview, request, error, done, notice, changed, runPreview, confirm, reset, chooseRenewal, setReason };
}

export type ChangeFlow = ReturnType<typeof useChangeFlow>;

export function PreviewPanel({
  flow,
  preview,
  onConfirm,
  onBack,
  confirmLabel,
  danger,
}: {
  flow: ChangeFlow;
  preview: ChangePreview;
  onConfirm: () => void;
  onBack: () => void;
  confirmLabel: string;
  danger?: boolean;
}) {
  const { pending } = flow;
  const after = preview.balanceAfterCents;
  const reason = flow.request?.reason ?? "";
  const missingReason = preview.reasonRequired && !reason.trim();
  return (
    <div className="mt-4 rounded-md border border-indigo-200 bg-indigo-50/50 p-4" data-testid="preview">
      {flow.changed && (
        <p role="alert" className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid="preview-changed">
          <span className="font-medium">Not saved. </span>
          {flow.changed}
        </p>
      )}
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
      {preview.renewal && (
        <RenewalSection
          effect={preview.renewal}
          cancelling={flow.request?.kind === "CANCELLATION" || preview.renewal.follow[0]?.action === "CANCEL"}
          pending={pending}
          onChoose={flow.chooseRenewal}
        />
      )}
      {preview.gapAfterOriginal && (
        <GapWarning gap={preview.gapAfterOriginal}>
          This policy would start after {preview.gapAfterOriginal.policyNumber}, the policy it renews, has ended.
        </GapWarning>
      )}
      {preview.reasonRequired && (
        <label className="mt-3 block">
          <span className="text-sm font-medium text-slate-700">
            Reason for leaving days without coverage (required)
          </span>
          <input
            name="gapReason"
            value={reason}
            onChange={(e) => flow.setReason(e.target.value)}
            placeholder="e.g. The customer let coverage lapse and came back two weeks later"
            className={inputClass}
          />
        </label>
      )}
      <div className="mt-4 flex gap-2">
        <button
          type="button"
          disabled={pending || missingReason}
          onClick={onConfirm}
          className={danger ? dangerButton : primaryButton}
        >
          <ButtonLabel pending={pending}>{confirmLabel}</ButtonLabel>
        </button>
        <button type="button" disabled={pending} onClick={onBack} className={secondaryButton}>
          Back
        </button>
      </div>
    </div>
  );
}

/** What happens to the policy's renewal, and the broker's choice about it. */
function RenewalSection({
  effect,
  cancelling,
  pending,
  onChoose,
}: {
  effect: NonNullable<ChangePreview["renewal"]>;
  cancelling: boolean;
  pending: boolean;
  onChoose: (choice: RenewalChoice) => void;
}) {
  const canFollow = effect.choices.includes("FOLLOW");
  const canKeep = effect.choices.includes("KEEP");
  return (
    <div className="mt-4 rounded-md border border-slate-200 bg-white p-3" data-testid="renewal-effect">
      <h4 className="text-sm font-semibold text-slate-900">This policy has been renewed as {effect.policyNumber}</h4>
      <p className="mt-0.5 text-xs text-slate-500">
        A renewal starts the day the policy before it ends. The two can never cover the same days.
      </p>
      <fieldset className="mt-2 space-y-2" disabled={pending}>
        <label className={`flex items-start gap-2 text-sm ${canFollow ? "" : "text-slate-400"}`}>
          <input
            type="radio"
            name="renewalChoice"
            value="FOLLOW"
            className="mt-1"
            checked={effect.chosen === "FOLLOW"}
            disabled={!canFollow}
            onChange={() => onChoose("FOLLOW")}
          />
          <span>
            <span className="font-medium">{cancelling ? "Cancel the renewal too" : "Move the renewal too"}</span>
            {canFollow ? (
              effect.follow.map((step) => <FollowLine key={step.policyId} step={step} />)
            ) : (
              <span className="block text-xs">Not possible: {effect.followBlocked}</span>
            )}
          </span>
        </label>
        <label className={`flex items-start gap-2 text-sm ${canKeep ? "" : "text-slate-400"}`}>
          <input
            type="radio"
            name="renewalChoice"
            value="KEEP"
            className="mt-1"
            checked={effect.chosen === "KEEP"}
            disabled={!canKeep}
            onChange={() => onChoose("KEEP")}
          />
          <span>
            <span className="font-medium">Leave the renewal where it is</span>
            <span className="block text-xs">
              {effect.gapIfKept
                ? `Leaves no coverage from ${formatDate(effect.gapIfKept.from)} to ${formatDate(effect.gapIfKept.to)} (${days(effect.gapIfKept)}). Needs a reason.`
                : "Not possible: the two policies would cover the same days."}
            </span>
          </span>
        </label>
      </fieldset>
      {effect.chosen === "KEEP" && effect.gapIfKept && (
        <GapWarning gap={effect.gapIfKept}>The renewal {effect.policyNumber} would start after this policy ends.</GapWarning>
      )}
    </div>
  );
}

/** One renewal that follows the change: what happens to it and to its balance. */
function FollowLine({ step }: { step: FollowStep }) {
  const after = step.balanceAfterCents;
  return (
    <span className="block text-xs text-slate-600" data-testid="renewal-follow">
      {step.policyNumber}: {step.summary}{" "}
      {step.netChangeCents === 0
        ? "Its premium doesn't change."
        : `Its premium changes by ${signedUSD(step.netChangeCents)}.`}{" "}
      {after > 0
        ? `${formatUSD(after)} will be due on it.`
        : after < 0
          ? `${formatUSD(-after)} will be refunded to the customer.`
          : "Nothing will be due on it."}
    </span>
  );
}

const days = (gap: Gap) => `${gap.days} ${gap.days === 1 ? "day" : "days"}`;

function GapWarning({ gap, children }: { gap: Gap; children: React.ReactNode }) {
  return (
    <p className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900" role="alert" data-testid="gap-warning">
      <span className="font-medium">
        No coverage from {formatDate(gap.from)} to {formatDate(gap.to)} ({days(gap)}).
      </span>{" "}
      {children} A loss in that time would not be covered.
    </p>
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
