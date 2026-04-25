/**
 * Framework-rule enforcement tests.
 *
 * These are the non-negotiable tests from prompt.md. They prove that the
 * validator is a real gate, not decoration. Every assertion here maps
 * back to one of Jeannie's 10 rules.
 *
 * If you find yourself loosening one of these tests to make a build pass,
 * that is a smell — talk to Adam first.
 */

import { describe, it, expect } from "vitest";
import type {
  Finding,
  ParsedInvoice,
  InvoiceRow,
  EvidenceRow,
} from "../types";
import { validateFindings, sumMonthlySaving } from "../engine/validate";
import { FRAMEWORK_RULES, getFrameworkRule, isFrameworkRule } from "../engine/framework";

/* ---------------------------------------------------------------------- */
/* Fixture helpers                                                        */
/* ---------------------------------------------------------------------- */

function fixtureInvoice(overrides: Partial<ParsedInvoice> = {}): ParsedInvoice {
  const rows: InvoiceRow[] = overrides.rows ?? [];
  return {
    customerName: "Fixture Co",
    period: { startDate: "2026-01-01", endDate: "2026-01-31", hoursInPeriod: 744 },
    displayCurrency: "USD",
    rows,
    totalCost: { amount: 10_000, currency: "USD" },
    totalCostUsd: { amount: 10_000, currency: "USD" },
    sourceFile: "fixture.xlsx",
    ...overrides,
  };
}

function fixtureFinding(overrides: Partial<Finding> = {}): Finding {
  const evidence: EvidenceRow[] = overrides.evidence ?? [
    { resourceId: "/vm/x", meter: "D8s v5", cost: 100, reason: "fixture" },
  ];
  return {
    id: "fixture",
    category: "lever",
    jeannieRule: 2,
    order: 1,
    title: "Fixture Finding",
    severity: "conditional",
    monthlySaving: 100,
    annualSaving: 1200,
    currency: "USD",
    confidence: "high",
    evidence,
    narrative: { customer: "c", consultant: "C", informational: "I" },
    discoveryQuestions: ["Do you hold SA?"],
    effort: "low",
    requiresConfirmation: [],
    ...overrides,
  };
}

/* ---------------------------------------------------------------------- */
/* Framework module sanity                                                */
/* ---------------------------------------------------------------------- */

describe("FRAMEWORK_RULES — module integrity", () => {
  it("contains exactly 10 rules numbered 1..10 in order", () => {
    expect(FRAMEWORK_RULES).toHaveLength(10);
    FRAMEWORK_RULES.forEach((r, i) => expect(r.number).toBe(i + 1));
  });

  it("every rule has a title and guidance", () => {
    for (const r of FRAMEWORK_RULES) {
      expect(r.title.trim().length).toBeGreaterThan(0);
      expect(r.guidance.trim().length).toBeGreaterThan(0);
    }
  });

  it("derived rules carry a derivedGuidance explanation; non-derived rules carry a statement", () => {
    for (const r of FRAMEWORK_RULES) {
      if (r.derived) {
        expect(r.derivedGuidance.trim().length).toBeGreaterThan(0);
      } else {
        expect(r.statement.trim().length).toBeGreaterThan(0);
        expect(r.transcriptLines.length).toBeGreaterThan(0);
      }
    }
  });

  it("getFrameworkRule throws on out-of-range numbers", () => {
    expect(() => getFrameworkRule(0)).toThrow();
    expect(() => getFrameworkRule(11)).toThrow();
    expect(isFrameworkRule(11)).toBe(false);
    expect(isFrameworkRule(5)).toBe(true);
  });
});

/* ---------------------------------------------------------------------- */
/* Rule 9 — discovery questions are mandatory                             */
/* ---------------------------------------------------------------------- */

describe("Jeannie Rule 9 — discovery questions are mandatory", () => {
  it("rejects a conditional finding with zero discovery questions", () => {
    const f = fixtureFinding({
      severity: "conditional",
      effort: "medium",
      discoveryQuestions: [],
    });
    const report = validateFindings([f], fixtureInvoice());
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.code === "RULE9_MISSING_DISCOVERY_QUESTION")).toBe(true);
  });

  it("allows a confirmed + low-effort finding with zero discovery questions", () => {
    const f = fixtureFinding({
      id: "trivial-delete",
      severity: "confirmed",
      effort: "low",
      discoveryQuestions: [],
    });
    const report = validateFindings([f], fixtureInvoice());
    expect(report.issues.some((i) => i.code === "RULE9_MISSING_DISCOVERY_QUESTION")).toBe(false);
  });
});

/* ---------------------------------------------------------------------- */
/* Rule 10 — investigate findings never aggregate                         */
/* ---------------------------------------------------------------------- */

describe("Jeannie Rule 10 — investigate findings never contribute to totals", () => {
  it("sumMonthlySaving excludes investigate severity", () => {
    const findings: Finding[] = [
      fixtureFinding({ id: "a", severity: "confirmed", monthlySaving: 100, annualSaving: 1200 }),
      fixtureFinding({ id: "b", severity: "conditional", monthlySaving: 50, annualSaving: 600 }),
      fixtureFinding({ id: "c", severity: "investigate", monthlySaving: 9999, annualSaving: 119988 }),
    ];
    expect(sumMonthlySaving(findings)).toBe(150);
  });

  it("validateFindings reports OK when investigate findings have huge claimed savings", () => {
    // The presence of a giant investigate finding must not trigger the
    // 'savings exceed invoice' error — because investigate is excluded.
    const f = fixtureFinding({
      id: "investigate-big",
      severity: "investigate",
      monthlySaving: 1_000_000,
      annualSaving: 12_000_000,
      discoveryQuestions: ["Is this a deliberate cost or runaway?"],
    });
    const report = validateFindings([f], fixtureInvoice({ totalCost: { amount: 100, currency: "USD" } }));
    expect(report.issues.some((i) => i.code === "CONFIRMED_SAVINGS_EXCEED_INVOICE")).toBe(false);
  });
});

/* ---------------------------------------------------------------------- */
/* Rule 2 — SQL Hybrid Benefit must be a range                            */
/* ---------------------------------------------------------------------- */

describe("Jeannie Rule 2 — SQL Hybrid Benefit is always a range", () => {
  it("rejects a sqlHybridBenefit finding without monthlySavingRange", () => {
    const f = fixtureFinding({
      id: "sqlHybridBenefit:server-x",
      jeannieRule: 2,
      monthlySaving: 500,
      annualSaving: 6000,
    });
    const report = validateFindings([f], fixtureInvoice());
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.code === "RULE2_SQL_HB_POINT_ESTIMATE")).toBe(true);
  });

  it("accepts a sqlHybridBenefit finding with monthlySavingRange", () => {
    const f = fixtureFinding({
      id: "sqlHybridBenefit:server-x",
      jeannieRule: 2,
      monthlySaving: null,
      annualSaving: null,
      monthlySavingRange: [120, 480],
      annualSavingRange: [1440, 5760],
      severity: "conditional",
      effort: "medium",
      discoveryQuestions: ["Which SQL Server edition is installed — Standard or Enterprise?"],
      evidence: [{ resourceId: "/vm/sql-x", meter: "D16s v5", cost: 0, reason: "uplift estimated" }],
    });
    const report = validateFindings([f], fixtureInvoice());
    expect(report.issues.some((i) => i.code === "RULE2_SQL_HB_POINT_ESTIMATE")).toBe(false);
  });
});

/* ---------------------------------------------------------------------- */
/* Mathematical invariants                                                */
/* ---------------------------------------------------------------------- */

describe("mathematical invariants", () => {
  it("rejects when annual ≠ monthly × 12", () => {
    const f = fixtureFinding({ monthlySaving: 100, annualSaving: 1000 /* should be 1200 */ });
    const report = validateFindings([f], fixtureInvoice());
    expect(report.issues.some((i) => i.code === "ANNUAL_MATH_MISMATCH")).toBe(true);
  });

  it("rejects when confirmed savings exceed invoice total", () => {
    const f = fixtureFinding({
      severity: "confirmed",
      effort: "low",
      monthlySaving: 999_999,
      annualSaving: 11_999_988,
      evidence: [{ resourceId: "/x", meter: "x", cost: 999_999, reason: "x" }],
    });
    const report = validateFindings([f], fixtureInvoice({ totalCost: { amount: 100, currency: "USD" } }));
    expect(report.issues.some((i) => i.code === "CONFIRMED_SAVINGS_EXCEED_INVOICE")).toBe(true);
  });

  it("warns when evidence sum drifts from claimed cost (and finding is not declared an estimate)", () => {
    const f = fixtureFinding({
      monthlySaving: 100,
      annualSaving: 1200,
      evidence: [{ resourceId: "/x", meter: "x", cost: 25, reason: "x" }],
    });
    const report = validateFindings([f], fixtureInvoice());
    expect(report.issues.some((i) => i.code === "EVIDENCE_RECONCILIATION_MISMATCH")).toBe(true);
  });
});

/* ---------------------------------------------------------------------- */
/* windowsHybridBenefit reference rule (optional smoke — runs without xlsx) */
/* ---------------------------------------------------------------------- */

describe("Jeannie Rule 3 — Windows HB ranks by vCore desc and aggregates the tail", async () => {
  const { windowsHybridBenefitRule } = await import("../engine/rules/windowsHybridBenefit");

  it("emits per-VM findings only for VMs with ≥8 vCores, ordered desc", () => {
    const rows: InvoiceRow[] = [
      vmRow("vm-big",   "D16s v5", 800),
      vmRow("vm-mid",   "D8s v5",  400),
      vmRow("vm-small", "B4ms",    50),
      vmRow("vm-tiny",  "B2s",     10),
    ];
    const out = windowsHybridBenefitRule.evaluate(fixtureInvoice({ rows }));
    expect(out).not.toBeNull();
    const findings = out as Finding[];

    const perVm = findings.filter((f) => f.id !== "windowsHybridBenefit:tail-under-8-cores");
    expect(perVm).toHaveLength(2); // vm-big (16) and vm-mid (8); vm-small/vm-tiny in tail
    expect(perVm[0].title).toContain("16-core");
    expect(perVm[1].title).toContain("8-core");
    // No per-VM finding for B4ms or B2s — they are in the tail
    expect(perVm.some((f) => f.id.includes("vm-small"))).toBe(false);
    expect(perVm.some((f) => f.id.includes("vm-tiny"))).toBe(false);

    const tail = findings.find((f) => f.id === "windowsHybridBenefit:tail-under-8-cores");
    expect(tail).toBeDefined();
    expect(tail!.severity).toBe("investigate"); // Rule 10 — does not aggregate
  });

  it("every emitted finding declares Jeannie rule 2 or 3 (lineage)", () => {
    const rows: InvoiceRow[] = [vmRow("vm-big", "D16s v5", 800)];
    const findings = windowsHybridBenefitRule.evaluate(fixtureInvoice({ rows })) as Finding[];
    for (const f of findings) {
      expect([2, 3]).toContain(f.jeannieRule);
    }
  });
});

function vmRow(name: string, meter: string, cost: number): InvoiceRow {
  return {
    resourceId: `/subscriptions/x/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/${name}`,
    resourceType: "microsoft.compute/virtualmachines",
    resourceLocation: "eastus",
    resourceGroupName: "rg",
    subscriptionName: "sub",
    serviceName: "Virtual Machines Licenses",
    meter,
    tags: "",
    costUsd: cost,
    cost,
    currency: "USD",
  };
}
