/**
 * Cross-check layer — runs after all rules have produced findings.
 *
 * Enforces invariants that come straight from Jeannie's framework:
 *
 *   - Rule 9: every non-low-effort, non-confirmed finding must carry at
 *     least one discovery question.
 *   - Rule 10: `investigate` severity findings must NOT contribute to any
 *     aggregated saving total.
 *   - Rule 2: Hybrid Benefit Layer 2 (SQL) findings must be a RANGE, never
 *     a point estimate.
 *   - Mathematical: confirmed savings cannot exceed the total invoice;
 *     evidence row costs reconcile to the finding's claimed cost (or the
 *     finding declares itself an estimate via monthlySavingRange);
 *     annual = monthly × 12 exactly; service percentages in any summary
 *     sum to ~100% (±0.5pp).
 *
 * The validation report is consumed by the renderer:
 *   - Informational audience  → visible inline.
 *   - Customer / Consultant   → collapsed appendix.
 *   - If `ok === false`       → export button shows a warning badge but
 *                                does not block (per prompt spec).
 */

import type {
  Finding,
  ParsedInvoice,
  ValidationIssue,
  ValidationReport,
} from "../types";
import { isFrameworkRule } from "./framework";

const EPSILON = 0.01;

export function validateFindings(
  findings: Finding[],
  invoice: ParsedInvoice
): ValidationReport {
  const issues: ValidationIssue[] = [];
  const evidenceReconciliation: ValidationReport["evidenceReconciliation"] = [];

  // ── 1. Confirmed-only savings total ≤ invoice total ─────────────────
  const confirmed = findings.filter((f) => f.severity === "confirmed");
  const confirmedTotal = sumMonthlySaving(confirmed);
  if (confirmedTotal > invoice.totalCost.amount + EPSILON) {
    issues.push({
      level: "error",
      code: "CONFIRMED_SAVINGS_EXCEED_INVOICE",
      message:
        `Sum of confirmed monthly savings (${confirmedTotal.toFixed(2)}) ` +
        `exceeds total invoice cost (${invoice.totalCost.amount.toFixed(2)}). ` +
        `A confirmed saving cannot exceed the bill it is offsetting.`,
    });
  }

  // ── 2. Per-finding checks ───────────────────────────────────────────
  for (const f of findings) {
    // Lineage: jeannieRule must be a real rule
    if (!isFrameworkRule(f.jeannieRule)) {
      issues.push({
        level: "error",
        code: "INVALID_FRAMEWORK_RULE",
        message: `Finding '${f.id}' declares jeannieRule=${f.jeannieRule}, which is not 1..10.`,
        findingId: f.id,
      });
    }

    // Evidence presence
    if (f.evidence.length === 0 && f.severity !== "investigate") {
      issues.push({
        level: "warning",
        code: "NO_EVIDENCE",
        message: `Finding '${f.id}' (severity=${f.severity}) has no evidence rows. ` +
          `Only 'investigate' findings may be evidence-free.`,
        findingId: f.id,
      });
    }

    // Evidence reconciliation: sum equals claimed cost OR finding is a range
    const evidenceSum = f.evidence.reduce((s, e) => s + e.cost, 0);
    const isEstimate = !!f.monthlySavingRange;
    if (f.monthlySaving !== null && f.evidence.length > 0 && !isEstimate) {
      const diff = Math.abs(evidenceSum - f.monthlySaving);
      if (diff > EPSILON) {
        issues.push({
          level: "warning",
          code: "EVIDENCE_RECONCILIATION_MISMATCH",
          message:
            `Finding '${f.id}': evidence rows sum to ${evidenceSum.toFixed(2)} but the ` +
            `monthly saving claim is ${f.monthlySaving.toFixed(2)}. ` +
            `Either the evidence is incomplete, the cost is an estimate (declare via monthlySavingRange), ` +
            `or there is an arithmetic bug in the rule.`,
          findingId: f.id,
        });
      }
    }
    evidenceReconciliation.push({
      findingId: f.id,
      claimed: f.monthlySaving ?? 0,
      evidenceSum,
      isEstimate,
    });

    // Annualised math: monthly × 12 exactly
    if (
      f.monthlySaving !== null &&
      f.annualSaving !== null &&
      Math.abs(f.annualSaving - f.monthlySaving * 12) > EPSILON
    ) {
      issues.push({
        level: "error",
        code: "ANNUAL_MATH_MISMATCH",
        message:
          `Finding '${f.id}': annualSaving (${f.annualSaving}) ≠ monthlySaving × 12 ` +
          `(${(f.monthlySaving * 12).toFixed(2)}).`,
        findingId: f.id,
      });
    }

    // FinOps Rule 9 — discovery questions mandatory unless trivially confirmed
    const requiresQuestion = !(f.severity === "confirmed" && f.effort === "low");
    if (requiresQuestion && f.discoveryQuestions.length === 0) {
      issues.push({
        level: "error",
        code: "RULE9_MISSING_DISCOVERY_QUESTION",
        message:
          `Finding '${f.id}' (severity=${f.severity}, effort=${f.effort}) has no ` +
          `discoveryQuestions. FinOps Rule 9: the engine never recommends action blind.`,
        findingId: f.id,
      });
    }

    // FinOps Rule 2 — SQL Hybrid Benefit must be a range, never a point estimate
    if (f.id.startsWith("sqlHybridBenefit") && !f.monthlySavingRange) {
      issues.push({
        level: "error",
        code: "RULE2_SQL_HB_POINT_ESTIMATE",
        message:
          `Finding '${f.id}' is a SQL Hybrid Benefit finding but has no monthlySavingRange. ` +
          `FinOps Rule 2: SQL HB must always be presented as a RANGE (Enterprise ceiling, ` +
          `Standard floor) — never a single number — because the edition is invisible on the invoice.`,
        findingId: f.id,
      });
    }
  }

  // ── 3. Service percentage summaries (if produced by upstream summary) ─
  // Currently a placeholder — once the summary builder lives in render/,
  // it will pass the percentage map in here for ±0.5pp validation.

  // ── 4. Resource-count claims in narratives — out of scope for v1 ─────

  const errorCount = issues.filter((i) => i.level === "error").length;

  return {
    ok: errorCount === 0,
    totalCost: invoice.totalCost,
    confirmedSavingsTotal: {
      amount: confirmedTotal,
      currency: invoice.displayCurrency,
    },
    issues,
    evidenceReconciliation,
  };
}

/**
 * Sums monthly saving across findings while honouring FinOps Rule 10:
 *   `investigate` findings are EXCLUDED from any aggregate total.
 *
 * Exported because both the validator and the savings-ladder builder need
 * to apply the same exclusion — keeping it in one place prevents drift.
 */
export function sumMonthlySaving(findings: Finding[]): number {
  let total = 0;
  for (const f of findings) {
    if (f.severity === "investigate") continue; // Rule 10
    if (f.monthlySaving !== null) {
      total += f.monthlySaving;
    } else if (f.monthlySavingRange) {
      // Conservative — use the floor for aggregates of conditional findings.
      total += f.monthlySavingRange[0];
    }
  }
  return total;
}
