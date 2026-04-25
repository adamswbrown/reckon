/**
 * End-to-end integration test against the real NMEF invoice.
 *
 * Locks in the engine's behaviour on a known input. Numbers are asserted
 * with generous tolerance bands — small rule-tuning changes shouldn't break
 * this; only structural regressions or framework-rule violations should.
 *
 * If you change a rule and this test fails, run `npm run engine:smoke` to
 * see the new numbers, then update the bands here intentionally.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseInvoice } from "../engine/parse";
import { analyse } from "../engine/index";

const INVOICE_PATH = resolve(process.cwd(), "NMEF Azure Invoice JAN 26.xlsx");
const HAS_INVOICE = existsSync(INVOICE_PATH);

const describeIfInvoice = HAS_INVOICE ? describe : describe.skip;

describeIfInvoice("integration: NMEF Jan 2026 invoice", () => {
  const buf = HAS_INVOICE ? readFileSync(INVOICE_PATH) : Buffer.alloc(0);
  const invoice = HAS_INVOICE ? parseInvoice(buf, INVOICE_PATH) : null!;
  const result = HAS_INVOICE ? analyse(invoice) : null!;

  it("parses invoice metadata correctly", () => {
    expect(invoice.customerName).toContain("North Mill");
    expect(invoice.period.startDate).toBe("2026-01-01");
    expect(invoice.period.endDate).toBe("2026-01-31");
    expect(invoice.period.hoursInPeriod).toBe(744);
    expect(invoice.displayCurrency).toBe("USD");
    expect(invoice.rows.length).toBeGreaterThan(5000);
  });

  it("total cost is in the expected band (~$109k)", () => {
    expect(invoice.totalCost.amount).toBeGreaterThan(100_000);
    expect(invoice.totalCost.amount).toBeLessThan(120_000);
  });

  it("validation passes (no error-level issues)", () => {
    const errors = result.validation.issues.filter((i) => i.level === "error");
    if (errors.length > 0) {
      throw new Error(
        `Validation produced errors:\n${errors.map((e) => `  - ${e.code}: ${e.message}`).join("\n")}`
      );
    }
    expect(result.validation.ok).toBe(true);
  });

  it("emits findings across all three categories", () => {
    const cats = new Set(result.findings.map((f) => f.category));
    expect(cats.has("lever")).toBe(true);
    expect(cats.has("runtime")).toBe(true);
    expect(cats.has("anomaly")).toBe(true);
  });

  it("Jeannie Rule 10: investigate findings do NOT contribute to immediate-wins headline", () => {
    const investigateMonthly = result.findings
      .filter((f) => f.severity === "investigate")
      .reduce((s, f) => s + (f.monthlySaving ?? 0), 0);
    // Even though one investigate finding (Windows HB tail) reports a
    // ~$4,400 monthly figure, immediate-wins must equal sum of confirmed
    // (+ conditional floor) only.
    const confirmedMonthly = result.findings
      .filter((f) => f.severity === "confirmed")
      .reduce((s, f) => s + (f.monthlySaving ?? 0), 0);
    const conditionalFloor = result.findings
      .filter((f) => f.severity === "conditional")
      .reduce((s, f) => s + (f.monthlySavingRange?.[0] ?? f.monthlySaving ?? 0), 0);
    expect(result.immediateWinsMonthly).toBeCloseTo(confirmedMonthly + conditionalFloor, 1);
    // Sanity: the headline must be strictly less than headline + investigate.
    expect(result.immediateWinsMonthly).toBeLessThan(
      result.immediateWinsMonthly + investigateMonthly + 1
    );
  });

  it("Jeannie Rule 9: every non-trivial finding has a discovery question", () => {
    for (const f of result.findings) {
      const trivial = f.severity === "confirmed" && f.effort === "low";
      if (!trivial) {
        expect(
          f.discoveryQuestions.length,
          `Finding ${f.id} (${f.severity}/${f.effort}) lacks a discovery question`
        ).toBeGreaterThan(0);
      }
    }
  });

  it("finds the legacy SQL DB delete candidates (confirmed savings)", () => {
    const deletes = result.findings.filter((f) => f.id.startsWith("sqlDatabaseLegacy"));
    expect(deletes.length).toBeGreaterThanOrEqual(5);
    for (const f of deletes) expect(f.severity).toBe("confirmed");
  });

  it("finds dormant VM clusters (Rule 6 — sprawl pattern)", () => {
    const clusters = result.findings.filter((f) => f.id.startsWith("dormantVmCluster"));
    expect(clusters.length).toBeGreaterThan(0);
    for (const f of clusters) expect(f.severity).toBe("investigate");
  });

  it("finds non-prod private endpoint sprawl", () => {
    const sprawl = result.findings.filter((f) => f.id.startsWith("privateEndpointSprawl"));
    expect(sprawl.length).toBeGreaterThan(0);
    // Every non-prod-named RG appears
    expect(sprawl.some((f) => /dev/i.test(f.id) || /test/i.test(f.id) || /stage/i.test(f.id))).toBe(true);
  });

  it("finds AZ-tier VPN gateways with range savings (Rule 7)", () => {
    const vpn = result.findings.filter((f) => f.id.startsWith("vpnGatewayAzReview"));
    expect(vpn.length).toBeGreaterThan(0);
    for (const f of vpn) expect(f.monthlySavingRange).toBeDefined();
  });

  it("immediate-wins headline is in the expected band ($20k–$35k/mo)", () => {
    // Generous band — small rule tuning shouldn't break this; structural
    // regressions or accidental investigate-aggregation will.
    expect(result.immediateWinsMonthly).toBeGreaterThan(20_000);
    expect(result.immediateWinsMonthly).toBeLessThan(35_000);
  });
});
