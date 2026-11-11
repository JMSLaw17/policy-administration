import { describe, expect, it } from "vitest";
import {
  addOneYear,
  allLines,
  allocateRefund,
  coveragesInForceOn,
  daysBetween,
  formatUSD,
  formulaFor,
  isISODate,
  planCorrection,
  PolicyRuleError,
  proRate,
  replay,
  totalPremiumCents,
  type HistoryItem,
  type PostedLine,
} from ".";

const GL = { code: "GL", annualPremiumCents: 109_500 };
const CYBER = { code: "CYBER", annualPremiumCents: 73_000 };
const PROP = { code: "PROP", annualPremiumCents: 36_500 };

const issue = (coverages = [GL]): HistoryItem => ({
  id: "issue",
  event: { type: "ISSUE", startDate: "2026-10-01", endDate: "2027-10-01", coverages },
});
const addCyber = (effectiveDate: string, id = "add-cyber"): HistoryItem => ({
  id,
  event: { type: "COVERAGE_CHANGE", effectiveDate, add: [CYBER], remove: [] },
});
const amounts = (history: HistoryItem[], eventId: string) =>
  replay(history).linesByEvent.get(eventId)!.map((l) => l.amountCents);

describe("dates", () => {
  it("counts the start day but not the end day", () => {
    expect(daysBetween("2026-10-01", "2026-10-08")).toBe(7);
    expect(daysBetween("2026-10-01", "2027-10-01")).toBe(365);
    expect(daysBetween("2027-10-01", "2028-10-01")).toBe(366); // crosses Feb 29, 2028
  });

  it("adds a year and rejects impossible dates", () => {
    expect(addOneYear("2026-10-01")).toBe("2027-10-01");
    expect(isISODate("2026-02-30")).toBe(false);
    expect(isISODate("2026-2-3")).toBe(false);
  });
});

describe("proRate", () => {
  it("charges the full premium for the full term", () => {
    expect(proRate(109_500, 365, 365)).toBe(109_500);
    expect(proRate(109_500, 366, 366)).toBe(109_500);
  });

  it("rounds to the nearest cent, halves up", () => {
    expect(proRate(100_000, 1, 365)).toBe(274); // 273.97...
    expect(proRate(100_000, 100, 365)).toBe(27_397); // 27397.26...
    expect(proRate(1, 1, 2)).toBe(1); // exactly half a cent rounds up
    expect(proRate(100_000, 0, 365)).toBe(0);
  });

  it("formats dollars", () => {
    expect(formatUSD(123_456)).toBe("$1,234.56");
    expect(formatUSD(-1_400)).toBe("-$14.00");
    expect(formatUSD(5)).toBe("$0.05");
  });
});

describe("the scenario reviewers will test", () => {
  it("issues the policy at the full annual premium", () => {
    expect(amounts([issue()], "issue")).toEqual([109_500]);
  });

  it("charges Cyber from Nov 1: $730 × 334 ÷ 365 = $668.00", () => {
    const [line] = replay([issue(), addCyber("2026-11-01")]).linesByEvent.get("add-cyber")!;
    expect(line).toMatchObject({ amountCents: 66_800, days: 334, termDays: 365, kind: "CHARGE" });
    expect(formulaFor(line)).toBe("$730.00 × 334 ÷ 365 days = $668.00");
  });

  it("corrects the start to Oct 25: reverse $668.00, charge $682.00, $14.00 more due", () => {
    const before = replay([issue(), addCyber("2026-11-01")]);
    const posted: PostedLine[] = allLines(before).map((l, i) => ({ ...l, entryId: `entry-${i}` }));

    const after = replay([issue(), addCyber("2026-10-25")]);
    const plan = planCorrection(posted, allLines(after));

    expect(plan.toReverse.map((l) => [l.coverageCode, l.amountCents])).toEqual([["CYBER", 66_800]]);
    expect(plan.toPost.map((l) => [l.coverageCode, l.amountCents, l.days])).toEqual([
      ["CYBER", 68_200, 341],
    ]);
    expect(plan.netChangeCents).toBe(1_400);
  });

  it("gives a credit if the date moves later instead", () => {
    const before = replay([issue(), addCyber("2026-11-01")]);
    const posted = allLines(before).map((l, i) => ({ ...l, entryId: `entry-${i}` }));
    const plan = planCorrection(posted, allLines(replay([issue(), addCyber("2026-11-08")])));
    expect(plan.netChangeCents).toBe(-1_400); // 7 fewer days at $2.00/day
  });

  it("can be corrected again, from the already-corrected state", () => {
    const posted = allLines(replay([issue(), addCyber("2026-10-25")])).map((l, i) => ({
      ...l,
      entryId: `entry-${i}`,
    }));
    const plan = planCorrection(posted, allLines(replay([issue(), addCyber("2026-10-20")])));
    expect(plan.toReverse.map((l) => l.amountCents)).toEqual([68_200]);
    expect(plan.toPost.map((l) => l.amountCents)).toEqual([69_200]);
    expect(plan.netChangeCents).toBe(1_000);
  });

  it("changes nothing when the correction makes no difference", () => {
    const state = replay([issue(), addCyber("2026-11-01")]);
    const posted = allLines(state).map((l, i) => ({ ...l, entryId: `entry-${i}` }));
    expect(planCorrection(posted, allLines(state))).toEqual({
      toReverse: [],
      toPost: [],
      netChangeCents: 0,
    });
  });
});

describe("editing coverage", () => {
  it("adds and removes in one change, with a line for each", () => {
    const history: HistoryItem[] = [
      issue([GL, PROP]),
      {
        id: "swap",
        event: { type: "COVERAGE_CHANGE", effectiveDate: "2027-04-01", add: [CYBER], remove: ["PROP"] },
      },
    ];
    const lines = replay(history).linesByEvent.get("swap")!;
    // 183 days left. Property credit $365 × 183 ÷ 365 = $183.00; Cyber charge $730 × 183 ÷ 365 = $366.00.
    expect(lines.map((l) => [l.coverageCode, l.kind, l.amountCents])).toEqual([
      ["PROP", "CREDIT", -18_300],
      ["CYBER", "CHARGE", 36_600],
    ]);
  });

  it("tracks when each coverage is in force", () => {
    const state = replay([issue(), addCyber("2026-11-01")]);
    expect(coveragesInForceOn(state, "2026-10-15").map((c) => c.code)).toEqual(["GL"]);
    expect(coveragesInForceOn(state, "2026-11-01").map((c) => c.code)).toEqual(["GL", "CYBER"]);
  });

  it("lets a removed coverage be added back later", () => {
    const state = replay([
      issue([GL, CYBER]),
      { id: "off", event: { type: "COVERAGE_CHANGE", effectiveDate: "2026-12-01", add: [], remove: ["CYBER"] } },
      addCyber("2027-02-01", "on"),
    ]);
    expect(state.intervals.filter((i) => i.code === "CYBER").map((i) => [i.from, i.to])).toEqual([
      ["2026-10-01", "2026-12-01"],
      ["2027-02-01", "2027-10-01"],
    ]);
  });

  it("refuses changes that don't make sense", () => {
    const bad = (item: HistoryItem, base = [issue()]) => () => replay([...base, item]);
    expect(bad(addCyber("2026-09-30"))).toThrow(/during the policy term/);
    expect(bad(addCyber("2027-10-01"))).toThrow(/during the policy term/);
    expect(bad(addCyber("2026-12-01"), [issue(), addCyber("2026-11-01", "first")])).toThrow(
      /already in force/,
    );
    expect(
      bad({ id: "x", event: { type: "COVERAGE_CHANGE", effectiveDate: "2026-11-01", add: [], remove: ["CYBER"] } }),
    ).toThrow(/isn't in force/);
    expect(
      bad({ id: "x", event: { type: "COVERAGE_CHANGE", effectiveDate: "2026-11-01", add: [], remove: ["GL"] } }),
    ).toThrow(/required/);
    expect(
      bad({ id: "x", event: { type: "COVERAGE_CHANGE", effectiveDate: "2026-11-01", add: [], remove: [] } }),
    ).toThrow(PolicyRuleError);
  });

  it("rejects a correction that would break a later change", () => {
    // Cyber added Nov 1, removed Feb 1. Moving the add to Mar 1 leaves nothing to remove on Feb 1.
    const removal: HistoryItem = {
      id: "remove",
      event: { type: "COVERAGE_CHANGE", effectiveDate: "2027-02-01", add: [], remove: ["CYBER"] },
    };
    expect(() => replay([issue(), addCyber("2026-11-01"), removal])).not.toThrow();
    try {
      replay([issue(), addCyber("2027-03-01"), removal]);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(PolicyRuleError);
      expect((e as PolicyRuleError).eventId).toBe("remove");
    }
  });
});

describe("cancellation (pro-rata, no penalty)", () => {
  const cancel = (effectiveDate: string): HistoryItem => ({
    id: "cancel",
    event: { type: "CANCELLATION", effectiveDate },
  });

  it("credits the unused days of every coverage: $549.00 + $366.00 = $915.00", () => {
    const state = replay([issue(), addCyber("2026-10-25"), cancel("2027-04-01")]);
    expect(state.linesByEvent.get("cancel")!.map((l) => [l.coverageCode, l.amountCents, l.days])).toEqual([
      ["GL", -54_900, 183],
      ["CYBER", -36_600, 183],
    ]);
    expect(state.cancelledEffective).toBe("2027-04-01");
    // Earned premium kept: GL 182 days ($546.00) + Cyber 158 days ($316.00).
    expect(totalPremiumCents(state)).toBe(54_600 + 31_600);
  });

  it("refunds everything when cancelled from the start date", () => {
    const state = replay([issue(), addCyber("2026-11-01"), cancel("2026-10-01")]);
    expect(totalPremiumCents(state)).toBe(0);
    expect(state.intervals).toEqual([]);
  });

  it("credits nothing when cancelled on the last day", () => {
    expect(replay([issue(), cancel("2027-10-01")]).linesByEvent.get("cancel")).toEqual([]);
  });

  it("blocks further changes after cancellation", () => {
    expect(() => replay([issue(), cancel("2027-04-01"), addCyber("2027-05-01")])).toThrow(/cancelled/);
    expect(() => replay([issue(), cancel("2027-10-02")])).toThrow(/within the policy term/);
  });
});

describe("issuing", () => {
  it("requires General Liability and an end date after the start", () => {
    expect(() => replay([issue([CYBER])])).toThrow(/General Liability is required/);
    expect(() =>
      replay([{ id: "i", event: { type: "ISSUE", startDate: "2026-10-01", endDate: "2026-10-01", coverages: [GL] } }]),
    ).toThrow(/end after it starts/);
    expect(() => replay([])).toThrow(PolicyRuleError);
  });
});

describe("allocateRefund", () => {
  const payments = [
    { paymentId: "first", amountCents: 109_500, alreadyRefundedCents: 0, paidAt: new Date("2026-10-01") },
    { paymentId: "second", amountCents: 66_800, alreadyRefundedCents: 0, paidAt: new Date("2026-10-20") },
  ];

  it("refunds the newest payment first", () => {
    expect(allocateRefund(1_400, payments)).toEqual({
      allocations: [{ paymentId: "second", amountCents: 1_400 }],
      shortfallCents: 0,
    });
  });

  it("spills over to older payments and respects earlier refunds", () => {
    const partlyRefunded = [payments[0], { ...payments[1], alreadyRefundedCents: 60_000 }];
    expect(allocateRefund(91_500, partlyRefunded)).toEqual({
      allocations: [
        { paymentId: "second", amountCents: 6_800 },
        { paymentId: "first", amountCents: 84_700 },
      ],
      shortfallCents: 0,
    });
  });

  it("reports what it couldn't refund", () => {
    expect(allocateRefund(200_000, payments).shortfallCents).toBe(200_000 - 176_300);
  });
});
