/**
 * Domain types for Reckon — the Azure FinOps health-check engine.
 *
 * Money is always carried with its currency. Never use `number` for cash
 * outside the engine boundary — it loses the currency context that the
 * Azure cost export carries in two columns (CostUSD + Cost/Currency).
 */

export type Currency = "USD" | "GBP" | "EUR" | "AUD" | string;

export interface Money {
  readonly amount: number;
  readonly currency: Currency;
}

/** Branded percentage. 0.40 means 40%. Use `pct(0.40)` to construct. */
export type Percent = number & { readonly __brand: "Percent" };
export const pct = (n: number): Percent => n as Percent;

/* ---------------------------------------------------------------------- */
/* Invoice model                                                          */
/* ---------------------------------------------------------------------- */

/**
 * Single billable line as emitted by Azure Cost analysis export.
 * Field names mirror the export header verbatim so the parser stays trivial
 * and reviewers can grep from spreadsheet to code.
 */
export interface InvoiceRow {
  resourceId: string;
  resourceType: string;          // microsoft.compute/virtualmachines, etc.
  resourceLocation: string;      // 'eastus', 'uksouth', 'unassigned', ''
  resourceGroupName: string;
  subscriptionName: string;
  serviceName: string;           // 'Virtual Machines', 'Azure App Service', ...
  meter: string;                 // SKU-level meter, e.g. 'E4as v4'
  tags: string;                  // raw JSON-ish blob from Azure
  costUsd: number;
  cost: number;
  currency: Currency;
}

export interface InvoicePeriod {
  /** ISO date — first day covered by the invoice. */
  startDate: string;
  /** ISO date — last day covered by the invoice (inclusive). */
  endDate: string;
  /** Hours in the period. Used for runtime-from-cost reverse engineering. */
  hoursInPeriod: number;
}

export interface ParsedInvoice {
  customerName: string;
  period: InvoicePeriod;
  /** Display currency for the report. Detected from rows, override-able. */
  displayCurrency: Currency;
  /** All rows, including zero-cost. Filtering is the rules' responsibility. */
  rows: InvoiceRow[];
  /** Sum of `cost` across all rows in displayCurrency. */
  totalCost: Money;
  /** Sum of `costUsd` across all rows. Useful for rate-table lookups. */
  totalCostUsd: Money;
  /** Provenance — which file this came from. */
  sourceFile: string;
}

/* ---------------------------------------------------------------------- */
/* Findings                                                               */
/* ---------------------------------------------------------------------- */

export type Severity = "confirmed" | "conditional" | "investigate";
export type Confidence = "high" | "medium" | "low";
export type Effort = "low" | "medium" | "high";
export type FindingCategory = "lever" | "runtime" | "anomaly";

export interface EvidenceRow {
  resourceId: string;
  meter: string;
  cost: number;             // in the finding's currency
  reason: string;           // one-line explanation of why this row is evidence
}

export interface AudienceNarrative {
  customer: string;
  consultant: string;
  informational: string;
}

export interface Finding {
  id: string;
  category: FindingCategory;
  /**
   * Which of Jeannie's 10 framework rules this finding implements.
   * Enforced by `validateFindings` — every finding must declare lineage.
   */
  jeannieRule: number;
  /** Display order within the audience-rendered report. */
  order: number;
  title: string;
  severity: Severity;
  monthlySaving: number | null;
  monthlySavingRange?: [number, number];
  annualSaving: number | null;
  annualSavingRange?: [number, number];
  currency: Currency;
  confidence: Confidence;
  evidence: EvidenceRow[];
  narrative: AudienceNarrative;
  /**
   * Required unless `severity === 'confirmed' && effort === 'low'`.
   * Enforces Jeannie Rule 9 — the engine never recommends action blind.
   */
  discoveryQuestions: string[];
  effort: Effort;
  /** Human / process gates that must be passed before action. */
  requiresConfirmation: string[];
}

/* ---------------------------------------------------------------------- */
/* Rule plug-in contract                                                  */
/* ---------------------------------------------------------------------- */

export interface FrameworkReference {
  /** 1..10, indexes into FRAMEWORK_RULES. */
  rule: number;
  /** Verbatim Jeannie quote OR engineering-derived guidance — see framework.ts. */
  quote: string;
}

export interface Rule {
  id: string;
  name: string;
  framework: FrameworkReference;
  evaluate(invoice: ParsedInvoice): Finding | Finding[] | null;
}

/* ---------------------------------------------------------------------- */
/* Validation report                                                      */
/* ---------------------------------------------------------------------- */

export type ValidationLevel = "info" | "warning" | "error";

export interface ValidationIssue {
  level: ValidationLevel;
  /** Stable code so the renderer can map to badges and the test suite can assert. */
  code: string;
  message: string;
  /** Optional — finding id this issue relates to. */
  findingId?: string;
}

/* ---------------------------------------------------------------------- */
/* Landscape — descriptive context (not actions)                          */
/* ---------------------------------------------------------------------- */

/**
 * A landscape card is a descriptive fact about the invoice — Pareto, top-N,
 * region distribution, tag coverage. They render BEFORE findings to give
 * the consultant context. Distinct from `Finding` because they:
 *   - never carry savings,
 *   - never claim a Jeannie rule lineage,
 *   - are computed even when no anomaly is present.
 *
 * Cards may *trigger* a Finding (e.g. low tag coverage → Rule 9 discovery
 * question), but the card itself is just data.
 */
export interface LandscapeCard {
  id: string;
  title: string;
  /** One-line headline — e.g. "20% of resources = 93.5% of spend". */
  headline: string;
  /** Tabular evidence — column order is the display order. */
  columns: string[];
  rows: Array<Record<string, string | number>>;
  /** Optional additional facts (counts, totals) for badge rendering. */
  metrics?: Record<string, string | number>;
}

export interface ValidationReport {
  ok: boolean;
  totalCost: Money;
  confirmedSavingsTotal: Money;
  issues: ValidationIssue[];
  /** Map of finding id → its claimed monthly cost vs evidence row sum. */
  evidenceReconciliation: Array<{
    findingId: string;
    claimed: number;
    evidenceSum: number;
    isEstimate: boolean;
  }>;
}
