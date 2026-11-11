import { z } from "zod";
import { isISODate, type HistoryItem, type PolicyEvent } from "@/lib/engine";

/**
 * Reading the policy history out of the database.
 *
 * Each money-affecting action (issue, coverage change, cancellation) is a
 * "slot" in the history. A correction doesn't add a slot; it becomes the new
 * version of the slot it corrects. The original version stays in the table,
 * marked as superseded.
 */

const isoDate = z.string().refine(isISODate, "Not a valid date");
const rate = z.object({ code: z.string(), annualPremiumCents: z.number().int().nonnegative() });

export const PolicyEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ISSUE"), startDate: isoDate, endDate: isoDate, coverages: z.array(rate) }),
  z.object({
    type: z.literal("COVERAGE_CHANGE"),
    effectiveDate: isoDate,
    add: z.array(rate),
    remove: z.array(z.string()),
  }),
  z.object({ type: z.literal("CANCELLATION"), effectiveDate: isoDate }),
]);

/** The fields of a PolicyTransaction row this module needs. */
export type TxRecord = {
  id: string;
  seq: number;
  type: string;
  data: unknown;
  correctsId: string | null;
};

export type Slot<T extends TxRecord = TxRecord> = {
  /** The original action. Its id identifies the slot. */
  root: T;
  /** The version that currently counts: the latest correction, or the root. */
  latest: T;
  /** Root first, then each correction in order. */
  versions: T[];
  event: PolicyEvent;
};

const MONEY_TYPES = new Set(["ISSUE", "COVERAGE_CHANGE", "CANCELLATION"]);

export function buildSlots<T extends TxRecord>(transactions: T[]): Slot<T>[] {
  const ordered = [...transactions].sort((a, b) => a.seq - b.seq);
  const correctionOf = new Map<string, T>();
  for (const t of ordered) if (t.correctsId) correctionOf.set(t.correctsId, t);

  return ordered
    .filter((t) => MONEY_TYPES.has(t.type))
    .map((root) => {
      const versions = [root];
      let next = correctionOf.get(root.id);
      while (next) {
        versions.push(next);
        next = correctionOf.get(next.id);
      }
      const latest = versions[versions.length - 1];
      return { root, latest, versions, event: PolicyEventSchema.parse(latest.data) };
    });
}

/** Maps every transaction id (original or correction) to its slot's root id. */
export function rootIdByTransaction(slots: Slot[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const slot of slots) for (const v of slot.versions) map.set(v.id, slot.root.id);
  return map;
}

export function toHistory(slots: Slot[]): HistoryItem[] {
  return slots.map((s) => ({ id: s.root.id, event: s.event }));
}
