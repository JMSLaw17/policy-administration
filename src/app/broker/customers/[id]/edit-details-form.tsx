"use client";

import { useActionState } from "react";
import { updateCustomerAction, type DetailsState } from "@/app/broker/actions";
import { inputClass, primaryButton } from "@/components/ui";
import type { CustomerDetails } from "@/lib/policies/details";

const fields: { name: keyof CustomerDetails; label: string; wide?: boolean; maxLength?: number }[] = [
  { name: "businessName", label: "Business name", wide: true },
  { name: "contactName", label: "Contact name" },
  { name: "email", label: "Contact email" },
  { name: "addressLine1", label: "Street address", wide: true },
  { name: "city", label: "City" },
  { name: "state", label: "State (2 letters)", maxLength: 2 },
  { name: "postalCode", label: "ZIP code" },
];

export function EditDetailsForm({ customerId, details }: { customerId: string; details: CustomerDetails }) {
  const [state, action, pending] = useActionState<DetailsState, FormData>(updateCustomerAction, undefined);
  return (
    <form action={action} className="grid gap-4 px-5 py-4 sm:grid-cols-2">
      <input type="hidden" name="customerId" value={customerId} />
      {fields.map((f) => (
        <label key={f.name} className={f.wide ? "block sm:col-span-2" : "block"}>
          <span className="text-sm font-medium text-slate-700">{f.label}</span>
          <input
            name={f.name}
            type={f.name === "email" ? "email" : "text"}
            defaultValue={details[f.name]}
            maxLength={f.maxLength}
            required
            className={inputClass}
          />
        </label>
      ))}
      <p className="text-xs text-slate-500 sm:col-span-2">
        These details don&apos;t affect any amount. Changing the contact email doesn&apos;t change the
        policyholder&apos;s login.
      </p>
      {state?.error && (
        <p role="alert" className="text-sm text-red-600 sm:col-span-2">
          {state.error}
        </p>
      )}
      {state?.saved && <p className="text-sm text-green-700 sm:col-span-2">{state.saved}</p>}
      <div className="sm:col-span-2">
        <button type="submit" disabled={pending} className={primaryButton}>
          {pending ? "Saving…" : "Save details"}
        </button>
      </div>
    </form>
  );
}
