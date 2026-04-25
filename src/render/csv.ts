/**
 * CSV renderer — emits two files:
 *
 *   {customer}_{period}_finops.csv
 *     One row per finding. Columns match the prompt spec exactly:
 *       id, category, jeannie_rule, order, title, severity, confidence,
 *       monthly_saving_low, monthly_saving_high, annual_saving_low,
 *       annual_saving_high, effort, evidence_count, evidence_total_cost,
 *       requires_confirmation, discovery_questions, action_description
 *
 *   {customer}_{period}_finops_evidence.csv
 *     One row per evidence row:
 *       finding_id, resource_id, meter, cost, reason
 *
 * No external CSV library — RFC 4180 quoting is small enough to inline,
 * and avoiding a dep keeps the Electron bundle slim.
 */

import type { Finding } from "../types";

export interface CsvOutputs {
  findingsCsv: string;
  evidenceCsv: string;
  findingsFilename: string;
  evidenceFilename: string;
}

export interface RenderCsvOptions {
  customerName: string;
  /** ISO start date used in the filename, e.g. '2026-01' or '2026-01-01'. */
  period: string;
}

export function renderCsv(findings: Finding[], options: RenderCsvOptions): CsvOutputs {
  const findingsRows: (string | number)[][] = [
    [
      "id", "category", "jeannie_rule", "order", "title", "severity", "confidence",
      "monthly_saving_low", "monthly_saving_high", "annual_saving_low",
      "annual_saving_high", "effort", "evidence_count", "evidence_total_cost",
      "requires_confirmation", "discovery_questions", "action_description",
    ],
  ];
  const evidenceRows: (string | number)[][] = [
    ["finding_id", "resource_id", "meter", "cost", "reason"],
  ];

  for (const f of findings) {
    const [mLow, mHigh] = monthlyRange(f);
    const [aLow, aHigh] = annualRange(f);
    const evidenceTotal = round2(f.evidence.reduce((s, e) => s + e.cost, 0));
    findingsRows.push([
      f.id,
      f.category,
      f.jeannieRule,
      f.order,
      f.title,
      f.severity,
      f.confidence,
      mLow ?? "",
      mHigh ?? "",
      aLow ?? "",
      aHigh ?? "",
      f.effort,
      f.evidence.length,
      evidenceTotal,
      f.requiresConfirmation.join(" | "),
      f.discoveryQuestions.join(" | "),
      // Action description = consultant narrative — most actionable form.
      f.narrative.consultant,
    ]);
    for (const e of f.evidence) {
      evidenceRows.push([f.id, e.resourceId, e.meter, e.cost, e.reason]);
    }
  }

  const safeCustomer = sanitiseFilenamePart(options.customerName);
  const safePeriod = sanitiseFilenamePart(options.period);

  return {
    findingsCsv: toCsv(findingsRows),
    evidenceCsv: toCsv(evidenceRows),
    findingsFilename: `${safeCustomer}_${safePeriod}_finops.csv`,
    evidenceFilename: `${safeCustomer}_${safePeriod}_finops_evidence.csv`,
  };
}

/* ---------------------------------------------------------------------- */
/* Helpers                                                                */
/* ---------------------------------------------------------------------- */

function monthlyRange(f: Finding): [number | null, number | null] {
  if (f.monthlySavingRange) return [f.monthlySavingRange[0], f.monthlySavingRange[1]];
  return [f.monthlySaving, f.monthlySaving];
}

function annualRange(f: Finding): [number | null, number | null] {
  if (f.annualSavingRange) return [f.annualSavingRange[0], f.annualSavingRange[1]];
  return [f.annualSaving, f.annualSaving];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function sanitiseFilenamePart(s: string): string {
  return s.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

/** RFC 4180-ish CSV writer. Quotes any field containing comma, quote, or newline. */
function toCsv(rows: (string | number | null | undefined)[][]): string {
  return rows.map((row) => row.map(csvField).join(",")).join("\r\n") + "\r\n";
}

function csvField(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
