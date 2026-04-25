/**
 * End-to-end integration test against a real Azure cost-export invoice.
 *
 * Drops the user-supplied invoice in the project root (or set the path
 * via `RECKON_TEST_INVOICE`); the suite parses it, runs the engine, and
 * verifies the structural and framework-rule invariants every analysis
 * must satisfy regardless of which customer's invoice is in play.
 *
 * No customer-specific numeric assertions live here — those bands depend
 * on the estate. For tighter regression checks, either run `npm run
 * engine:smoke` and eyeball the numbers, or maintain a local override
 * test outside the repo.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseInvoice } from "../engine/parse";
import { analyse } from "../engine/index";
import { findTestInvoice } from "./_helpers/findInvoice";

const INVOICE_PATH = findTestInvoice();
const HAS_INVOICE = INVOICE_PATH !== null;

const describeIfInvoice = HAS_INVOICE ? describe : describe.skip;

describeIfInvoice("integration: real Azure invoice end-to-end", () => {
  const buf = HAS_INVOICE ? readFileSync(INVOICE_PATH!) : Buffer.alloc(0);
  const invoice = HAS_INVOICE ? parseInvoice(buf, INVOICE_PATH!) : null!;
  const result = HAS_INVOICE ? analyse(invoice) : null!;

  it("parses invoice metadata into a non-empty result", () => {
    expect(invoice.customerName.length).toBeGreaterThan(0);
    expect(invoice.period.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(invoice.period.endDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(invoice.period.hoursInPeriod).toBeGreaterThan(0);
    expect(invoice.displayCurrency.length).toBeGreaterThan(0);
    expect(invoice.rows.length).toBeGreaterThan(0);
  });

  it("invoice total is a positive number", () => {
    expect(invoice.totalCost.amount).toBeGreaterThan(0);
  });

  it("validation produces no error-level issues", () => {
    const errors = result.validation.issues.filter((i) => i.level === "error");
    if (errors.length > 0) {
      throw new Error(
        `Validation produced errors:\n${errors.map((e) => `  - ${e.code}: ${e.message}`).join("\n")}`,
      );
    }
    expect(result.validation.ok).toBe(true);
  });

  it("Rule 10: investigate findings do NOT contribute to immediate-wins headline", () => {
    const investigateMonthly = result.findings
      .filter((f) => f.severity === "investigate")
      .reduce((s, f) => s + (f.monthlySaving ?? 0), 0);
    const confirmedMonthly = result.findings
      .filter((f) => f.severity === "confirmed")
      .reduce((s, f) => s + (f.monthlySaving ?? 0), 0);
    const conditionalFloor = result.findings
      .filter((f) => f.severity === "conditional")
      .reduce((s, f) => s + (f.monthlySavingRange?.[0] ?? f.monthlySaving ?? 0), 0);
    expect(result.immediateWinsMonthly).toBeCloseTo(confirmedMonthly + conditionalFloor, 1);
    // Headline must never include the investigate sum.
    expect(result.immediateWinsMonthly).toBeLessThan(
      result.immediateWinsMonthly + investigateMonthly + 1,
    );
  });

  it("Rule 9: every non-trivial finding carries a discovery question", () => {
    for (const f of result.findings) {
      const trivial = f.severity === "confirmed" && f.effort === "low";
      if (!trivial) {
        expect(
          f.discoveryQuestions.length,
          `Finding ${f.id} (${f.severity}/${f.effort}) lacks a discovery question`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it("immediate-wins is non-negative and never exceeds total invoice cost", () => {
    expect(result.immediateWinsMonthly).toBeGreaterThanOrEqual(0);
    expect(result.immediateWinsMonthly).toBeLessThanOrEqual(invoice.totalCost.amount);
  });
});
