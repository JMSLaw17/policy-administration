"use client";

import { useState } from "react";
import { FormError, PreviewPanel, SavedNotice, useChangeFlow } from "./change-flow";
import { ButtonLabel, Card, inputClass, primaryButton, secondaryButton } from "@/components/ui";
import {
  COVERAGES,
  formatDate,
  formatUSD,
  type CoverageInterval,
  type ISODate,
  type PolicyEvent,
} from "@/lib/engine";
import type { CorrectedEvent } from "@/lib/policies/service";

/* ---------------------------- Edit coverage ---------------------------- */

export function EditCoverageCard({
  policyId,
  coverage,
  startDate,
  endDate,
  today,
}: {
  policyId: string;
  coverage: CoverageInterval[];
  startDate: ISODate;
  endDate: ISODate;
  today: ISODate;
}) {
  const flow = useChangeFlow(policyId);
  const defaultDate = today < startDate ? startDate : today >= endDate ? startDate : today;
  const [date, setDate] = useState(defaultDate);
  const [reason, setReason] = useState("");
  // The reason can be edited after the preview. It goes to the flow as well, so the
  // one saved is the one on screen when the broker confirms, not the one at preview time.
  const changeReason = (value: string) => {
    setReason(value);
    flow.setReason(value);
  };

  // Which coverages are on from the chosen date onward.
  const onFrom = (d: ISODate) =>
    COVERAGES.filter((c) => coverage.some((i) => i.code === c.code && i.from <= d && d < i.to)).map((c) => c.code);
  const [selected, setSelected] = useState<string[]>(onFrom(defaultDate));

  const current = onFrom(date);
  const add = selected.filter((c) => !current.includes(c));
  const remove = current.filter((c) => !selected.includes(c));
  const unchanged = add.length === 0 && remove.length === 0;

  const changeDate = (next: ISODate) => {
    setDate(next);
    setSelected(onFrom(next));
    flow.reset();
  };
  const toggle = (code: string) => {
    setSelected((s) => (s.includes(code) ? s.filter((c) => c !== code) : [...s, code]));
    flow.reset();
  };

  return (
    <Card
      id="edit-coverage"
      title="Edit coverage"
      description="Pick the date the change takes effect, then tick the coverages the policy should have from that date."
    >
      <div className="px-5 py-4">
        <div className="grid gap-4 sm:grid-cols-[14rem_1fr]">
          <label className="block">
            <span className="text-sm font-medium text-slate-700">Effective date</span>
            <input
              type="date"
              name="effectiveDate"
              value={date}
              min={startDate}
              max={endDate}
              onChange={(e) => changeDate(e.target.value)}
              className={inputClass}
            />
          </label>
          <fieldset>
            <legend className="text-sm font-medium text-slate-700">Coverages from {date ? formatDate(date) : "…"}</legend>
            <div className="mt-1 space-y-1.5">
              {COVERAGES.map((c) => {
                const was = current.includes(c.code);
                const now = selected.includes(c.code);
                return (
                  <label key={c.code} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      name="coverages"
                      value={c.code}
                      checked={now}
                      disabled={c.required}
                      onChange={() => toggle(c.code)}
                      className="size-4 rounded border-slate-300"
                    />
                    <span className="text-slate-900">{c.name}</span>
                    <span className="text-slate-500">{formatUSD(c.annualPremiumCents)}/yr</span>
                    {c.required && <span className="text-xs text-slate-400">required</span>}
                    {!was && now && <span className="text-xs font-medium text-green-700">will be added</span>}
                    {was && !now && <span className="text-xs font-medium text-red-700">will be removed</span>}
                  </label>
                );
              })}
            </div>
          </fieldset>
        </div>
        <label className="mt-4 block">
          <span className="text-sm font-medium text-slate-700">Reason (optional)</span>
          <input value={reason} onChange={(e) => changeReason(e.target.value)} className={inputClass} />
        </label>

        {!flow.preview && (
          <button
            type="button"
            disabled={flow.pending || unchanged}
            onClick={() => flow.runPreview({ kind: "COVERAGE_CHANGE", effectiveDate: date, add, remove, reason })}
            className={`${primaryButton} mt-4`}
          >
            <ButtonLabel pending={flow.pending}>Preview change</ButtonLabel>
          </button>
        )}
        <FormError error={flow.error} />
        <SavedNotice done={flow.done} notice={flow.notice} label="Coverage change saved." />
        {flow.preview && (
          <PreviewPanel
            flow={flow}
            preview={flow.preview}
            confirmLabel="Confirm coverage change"
            onConfirm={() => flow.confirm(() => setReason(""))}
            onBack={flow.reset}
          />
        )}
      </div>
    </Card>
  );
}

/* ------------------------------- Cancel ------------------------------- */

export function CancelCard({
  policyId,
  startDate,
  endDate,
  today,
}: {
  policyId: string;
  startDate: ISODate;
  endDate: ISODate;
  today: ISODate;
}) {
  const flow = useChangeFlow(policyId);
  const [date, setDate] = useState(today < startDate ? startDate : today > endDate ? endDate : today);
  const [reason, setReason] = useState("");
  // The reason can be edited after the preview. It goes to the flow as well, so the
  // one saved is the one on screen when the broker confirms, not the one at preview time.
  const changeReason = (value: string) => {
    setReason(value);
    flow.setReason(value);
  };

  return (
    <Card
      id="cancel"
      title="Cancel policy"
      description="Pro-rata: the customer pays only for days up to the cancellation date. Anything they paid beyond that is refunded."
    >
      <div className="px-5 py-4">
        <div className="grid gap-4 sm:grid-cols-[14rem_1fr]">
          <label className="block">
            <span className="text-sm font-medium text-slate-700">Cancellation date</span>
            <input
              type="date"
              value={date}
              min={startDate}
              max={endDate}
              onChange={(e) => {
                setDate(e.target.value);
                flow.reset();
              }}
              className={inputClass}
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-slate-700">Reason (optional)</span>
            <input value={reason} onChange={(e) => changeReason(e.target.value)} className={inputClass} />
          </label>
        </div>
        {!flow.preview && (
          <button
            type="button"
            disabled={flow.pending}
            onClick={() => flow.runPreview({ kind: "CANCELLATION", effectiveDate: date, reason })}
            className={`${secondaryButton} mt-4`}
          >
            <ButtonLabel pending={flow.pending}>Preview cancellation</ButtonLabel>
          </button>
        )}
        <FormError error={flow.error} />
        {flow.preview && (
          <PreviewPanel
            flow={flow}
            preview={flow.preview}
            confirmLabel="Cancel the policy"
            danger
            onConfirm={() => flow.confirm()}
            onBack={flow.reset}
          />
        )}
      </div>
    </Card>
  );
}

/* ------------------------------ Correct ------------------------------ */

type Choice = "none" | "add" | "remove";

export function CorrectControl({
  policyId,
  transactionId,
  seq,
  event,
}: {
  policyId: string;
  transactionId: string;
  seq: number;
  event: PolicyEvent;
}) {
  const flow = useChangeFlow(policyId);
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(event.type === "ISSUE" ? event.startDate : event.effectiveDate);
  const [reason, setReason] = useState("");
  // The reason can be edited after the preview. It goes to the flow as well, so the
  // one saved is the one on screen when the broker confirms, not the one at preview time.
  const changeReason = (value: string) => {
    setReason(value);
    flow.setReason(value);
  };
  const [issued, setIssued] = useState<string[]>(
    event.type === "ISSUE" ? event.coverages.map((c) => c.code) : [],
  );
  const [choices, setChoices] = useState<Record<string, Choice>>(() =>
    Object.fromEntries(
      COVERAGES.map((c) => [
        c.code,
        event.type !== "COVERAGE_CHANGE"
          ? "none"
          : event.add.some((a) => a.code === c.code)
            ? "add"
            : event.remove.includes(c.code)
              ? "remove"
              : "none",
      ]),
    ),
  );

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={`${secondaryButton} mt-3 !px-2.5 !py-1 text-xs`}>
        Correct this
      </button>
    );
  }

  const corrected = (): CorrectedEvent => {
    if (event.type === "ISSUE") return { type: "ISSUE", startDate: date, coverages: issued };
    if (event.type === "CANCELLATION") return { type: "CANCELLATION", effectiveDate: date };
    const pick = (choice: Choice) => COVERAGES.filter((c) => choices[c.code] === choice).map((c) => c.code);
    return { type: "COVERAGE_CHANGE", effectiveDate: date, add: pick("add"), remove: pick("remove") };
  };
  const close = () => {
    flow.reset();
    setOpen(false);
  };

  return (
    <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 p-4" data-testid={`correct-${seq}`}>
      <h3 className="text-sm font-semibold text-slate-900">Correct #{seq}</h3>
      <p className="mt-0.5 text-xs text-slate-500">
        Enter what should have been recorded. The original stays in the history and on the statement, with a
        reversal next to it.
      </p>
      <div className="mt-3 grid gap-4 sm:grid-cols-[14rem_1fr]">
        <label className="block">
          <span className="text-sm font-medium text-slate-700">
            {event.type === "ISSUE" ? "Policy start date" : event.type === "CANCELLATION" ? "Cancellation date" : "Effective date"}
          </span>
          <input
            type="date"
            name="correctedDate"
            value={date}
            onChange={(e) => {
              setDate(e.target.value);
              flow.reset();
            }}
            className={inputClass}
          />
        </label>

        {event.type === "ISSUE" && (
          <fieldset>
            <legend className="text-sm font-medium text-slate-700">Coverages issued</legend>
            <div className="mt-1 space-y-1.5">
              {COVERAGES.map((c) => (
                <label key={c.code} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={issued.includes(c.code)}
                    disabled={c.required}
                    onChange={() => {
                      setIssued((s) => (s.includes(c.code) ? s.filter((x) => x !== c.code) : [...s, c.code]));
                      flow.reset();
                    }}
                    className="size-4 rounded border-slate-300"
                  />
                  {c.name}
                </label>
              ))}
            </div>
          </fieldset>
        )}

        {event.type === "COVERAGE_CHANGE" && (
          <fieldset>
            <legend className="text-sm font-medium text-slate-700">What this change did</legend>
            <div className="mt-1 space-y-1.5">
              {COVERAGES.filter((c) => !c.required).map((c) => (
                <label key={c.code} className="flex items-center gap-2 text-sm">
                  <select
                    value={choices[c.code]}
                    onChange={(e) => {
                      setChoices((s) => ({ ...s, [c.code]: e.target.value as Choice }));
                      flow.reset();
                    }}
                    className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm"
                  >
                    <option value="none">No change to</option>
                    <option value="add">Added</option>
                    <option value="remove">Removed</option>
                  </select>
                  {c.name}
                </label>
              ))}
            </div>
          </fieldset>
        )}
      </div>
      <label className="mt-4 block">
        <span className="text-sm font-medium text-slate-700">Reason for the correction</span>
        <input
          name="correctionReason"
          value={reason}
          onChange={(e) => changeReason(e.target.value)}
          placeholder="e.g. Coverage actually began a week earlier than recorded"
          className={inputClass}
        />
      </label>

      {!flow.preview && (
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            disabled={flow.pending}
            onClick={() => flow.runPreview({ kind: "CORRECTION", transactionId, event: corrected(), reason })}
            className={primaryButton}
          >
            <ButtonLabel pending={flow.pending}>Preview correction</ButtonLabel>
          </button>
          <button type="button" onClick={close} className={secondaryButton}>
            Close
          </button>
        </div>
      )}
      <FormError error={flow.error} />
      {flow.preview && (
        <PreviewPanel
          flow={flow}
          preview={flow.preview}
          confirmLabel="Confirm correction"
          onConfirm={() => flow.confirm(close)}
          onBack={flow.reset}
        />
      )}
    </div>
  );
}
