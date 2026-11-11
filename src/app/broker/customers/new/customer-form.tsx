"use client";

import { useActionState } from "react";
import { createCustomer, type FormState } from "@/app/broker/actions";
import { inputClass, primaryButton } from "@/components/ui";

const fields = [
  { name: "businessName", label: "Business name", span: 2 },
  { name: "contactName", label: "Contact name", span: 1 },
  { name: "email", label: "Contact email (also their login)", span: 1, type: "email" },
  { name: "addressLine1", label: "Street address", span: 2 },
  { name: "city", label: "City", span: 1 },
  { name: "state", label: "State (2 letters)", span: 1, maxLength: 2 },
  { name: "postalCode", label: "ZIP code", span: 1 },
] as const;

export function CustomerForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(createCustomer, undefined);
  return (
    <form action={action} className="grid gap-4 px-5 py-4 sm:grid-cols-2">
      {fields.map((f) => (
        <label key={f.name} className={f.span === 2 ? "block sm:col-span-2" : "block"}>
          <span className="text-sm font-medium text-slate-700">{f.label}</span>
          <input
            name={f.name}
            type={"type" in f ? f.type : "text"}
            maxLength={"maxLength" in f ? f.maxLength : undefined}
            required
            className={inputClass}
          />
        </label>
      ))}
      {state?.error && (
        <p role="alert" className="text-sm text-red-600 sm:col-span-2">
          {state.error}
        </p>
      )}
      <div className="sm:col-span-2">
        <button type="submit" disabled={pending} className={primaryButton}>
          {pending ? "Creating…" : "Create customer"}
        </button>
      </div>
    </form>
  );
}
