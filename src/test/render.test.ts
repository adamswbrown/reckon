/**
 * HTML renderer tests — focused on the audience-aware visibility contract
 * and on guaranteeing the report is self-contained (no external assets).
 */

import { describe, it, expect } from "vitest";
import type { Finding, ParsedInvoice } from "../types";
import type { AnalysisResult } from "../engine/index";
import { renderHtml } from "../render/html";
import { renderCsv } from "../render/csv";
import { esc } from "../render/escape";

function fixtureFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "fixture",
    category: "lever",
    jeannieRule: 2,
    order: 1,
    title: "Fixture finding",
    severity: "conditional",
    monthlySaving: null,
    annualSaving: null,
    monthlySavingRange: [100, 200],
    annualSavingRange: [1200, 2400],
    currency: "USD",
    confidence: "high",
    evidence: [{ resourceId: "/sub/x/rg/y/vm/z", meter: "D8s v5", cost: 100, reason: "fixture" }],
    narrative: {
      customer: "CUSTOMER NARRATIVE STRING",
      consultant: "CONSULTANT NARRATIVE STRING",
      informational: "INFORMATIONAL NARRATIVE STRING",
    },
    discoveryQuestions: ["Do you have SA?"],
    effort: "low",
    requiresConfirmation: [],
    ...overrides,
  };
}

function fixtureResult(findings: Finding[]): AnalysisResult {
  const invoice: ParsedInvoice = {
    customerName: "Test Customer Inc",
    period: { startDate: "2026-01-01", endDate: "2026-01-31", hoursInPeriod: 744 },
    displayCurrency: "USD",
    rows: [],
    totalCost: { amount: 50_000, currency: "USD" },
    totalCostUsd: { amount: 50_000, currency: "USD" },
    sourceFile: "fixture.xlsx",
  };
  return {
    invoice,
    findings,
    landscape: [],
    validation: {
      ok: true,
      totalCost: invoice.totalCost,
      confirmedSavingsTotal: { amount: 0, currency: "USD" },
      issues: [],
      evidenceReconciliation: [],
    },
    immediateWinsMonthly: 100,
  };
}

describe("escape", () => {
  it("escapes script tags and quotes", () => {
    expect(esc(`<script>alert('x')</script>`)).toBe(
      "&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;"
    );
  });
});

describe("renderHtml — audience contract", () => {
  const findings = [fixtureFinding()];
  const result = fixtureResult(findings);

  it("emits all three narratives in the markup, regardless of audience", () => {
    // Visibility is CSS-driven so every narrative is present in every audience's HTML.
    for (const audience of ["customer", "consultant", "informational"] as const) {
      const out = renderHtml(result, { audience });
      expect(out.html).toContain("CUSTOMER NARRATIVE STRING");
      expect(out.html).toContain("CONSULTANT NARRATIVE STRING");
      expect(out.html).toContain("INFORMATIONAL NARRATIVE STRING");
    }
  });

  it("sets the correct body class per audience", () => {
    expect(renderHtml(result, { audience: "customer" }).html).toMatch(/body class="aud-customer"/);
    expect(renderHtml(result, { audience: "consultant" }).html).toMatch(/body class="aud-consultant"/);
    expect(renderHtml(result, { audience: "informational" }).html).toMatch(/body class="aud-informational"/);
  });

  it("writes an audience-stamped filename per spec", () => {
    expect(renderHtml(result, { audience: "customer" }).filename).toContain("_customer.html");
    expect(renderHtml(result, { audience: "consultant" }).filename).toContain("_consultant.html");
    expect(renderHtml(result, { audience: "informational" }).filename).toContain("_informational.html");
    expect(renderHtml(result, { audience: "consultant" }).filename).toContain("Test-Customer-Inc");
    expect(renderHtml(result, { audience: "consultant" }).filename).toContain("2026-01");
  });
});

describe("renderHtml — self-contained", () => {
  const out = renderHtml(fixtureResult([fixtureFinding()]), { audience: "consultant" });

  it("contains no external asset URLs (no <link>, no <img src=https>, no http fonts)", () => {
    expect(out.html).not.toMatch(/<link\b[^>]*\bhref=/i);
    expect(out.html).not.toMatch(/<img\b[^>]*src="https?:/i);
    expect(out.html).not.toMatch(/@import\s+url\(['"]?https?:/i);
    expect(out.html).not.toMatch(/href="https?:\/\/fonts/i);
  });

  it("inlines a <style> block and a <script> block", () => {
    expect(out.html).toMatch(/<style>[\s\S]+<\/style>/);
    expect(out.html).toMatch(/<script>[\s\S]+<\/script>/);
  });

  it("escapes attacker-controllable strings in the customer name", () => {
    const evil = renderHtml(
      fixtureResult([fixtureFinding({ title: `<img src=x onerror=alert(1)>` })]),
      { audience: "consultant" }
    );
    expect(evil.html).not.toContain(`<img src=x onerror=alert(1)>`);
    expect(evil.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
});

describe("renderHtml — savings ladder excludes investigate signals from totals", () => {
  it("renders 'investigate' rung as a text-only exclusion, no money figure", () => {
    const findings = [
      fixtureFinding({ id: "a", severity: "investigate", monthlySaving: 99999 }),
      fixtureFinding({ id: "b", severity: "confirmed", monthlySaving: 100, annualSaving: 1200, monthlySavingRange: undefined, annualSavingRange: undefined, evidence: [{ resourceId: "/x", meter: "x", cost: 100, reason: "x" }] }),
    ];
    const html = renderHtml(fixtureResult(findings), { audience: "consultant" }).html;
    expect(html).toContain("excluded from totals");
    const rungMatch = html.match(/<div class="rung investigate">[\s\S]*?<span class="value">([\s\S]*?)<\/span>/);
    expect(rungMatch).not.toBeNull();
    expect(rungMatch![1]).toContain("excluded from totals");
    // No money figure should appear in the rung value cell.
    expect(rungMatch![1]).not.toMatch(/\d/);
  });
});

describe("renderCsv (sanity)", () => {
  it("emits two CSVs with audience-agnostic content", () => {
    const out = renderCsv([fixtureFinding()], { customerName: "X Y", period: "2026-01" });
    expect(out.findingsCsv.split("\r\n")[0]).toMatch(/^id,category,jeannie_rule/);
    expect(out.evidenceCsv.split("\r\n")[0]).toBe("finding_id,resource_id,meter,cost,reason");
    expect(out.findingsFilename).toBe("X-Y_2026-01_finops.csv");
    expect(out.evidenceFilename).toBe("X-Y_2026-01_finops_evidence.csv");
  });
});
