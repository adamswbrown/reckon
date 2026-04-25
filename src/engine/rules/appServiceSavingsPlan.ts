/**
 * Rule: Azure App Service → 3-year Compute Savings Plan recommendation.
 * Implements Jeannie Rule 1 (Savings Plans, third lever) and Jeannie Rule 5
 * (3-year terms are not a trap — exchange dollar-for-dollar).
 *
 * Detection
 * ---------
 * Group all `Azure App Service` rows by App Service Plan (extracted from
 * the `serverfarms/<plan-name>` segment of the resourceId). Aggregate the
 * monthly cost. The Compute Savings Plan typically delivers 30–65% off
 * Standard/Premium tiers — we present the conservative band.
 *
 * Severity: `conditional` — saving is subject to plan term acceptance and
 * commit to a steady-state utilisation, but the math is straightforward.
 */

import type { Finding, ParsedInvoice, Rule, EvidenceRow, InvoiceRow } from "../../types";
import { round2, formatMoney } from "./_helpers";
import { getFrameworkRule } from "../framework";

const COMPUTE_SP_DISCOUNT_LOW = 0.30;
const COMPUTE_SP_DISCOUNT_HIGH = 0.50;

function planNameFromResourceId(rid: string): string | null {
  const m = rid.match(/serverfarms\/([^/]+)/i);
  return m?.[1] ?? null;
}

export const appServiceSavingsPlanRule: Rule = {
  id: "appServiceSavingsPlan",
  name: "Azure App Service → 3-year Compute Savings Plan",
  framework: { rule: 1, quote: "Jeannie Rule 1 — Savings Plans are the third lever, after HB and Reservations." },

  evaluate(invoice: ParsedInvoice): Finding[] | null {
    type Plan = { plan: string; cost: number; rows: InvoiceRow[]; tier: string };
    const byPlan = new Map<string, Plan>();
    for (const r of invoice.rows) {
      if (r.serviceName !== "Azure App Service") continue;
      // Skip free tier and consumption-mode rows (no commit value).
      if (/^F\d+/i.test(r.meter)) continue;
      const plan = planNameFromResourceId(r.resourceId);
      if (!plan) continue;
      const tier = (r.meter.match(/^([A-Z]\d+\s*v?\d*)/) ?? [, "?"])[1] ?? "?";
      const p = byPlan.get(plan) ?? { plan, cost: 0, rows: [], tier };
      p.cost += r.cost;
      p.rows.push(r);
      byPlan.set(plan, p);
    }
    if (byPlan.size === 0) return null;

    const plans = [...byPlan.values()].filter((p) => p.cost > 0);
    if (plans.length === 0) return null;

    const totalCost = round2(plans.reduce((s, p) => s + p.cost, 0));
    const monthlyLow = round2(totalCost * COMPUTE_SP_DISCOUNT_LOW);
    const monthlyHigh = round2(totalCost * COMPUTE_SP_DISCOUNT_HIGH);

    const evidence: EvidenceRow[] = plans.slice(0, 25).map((p) => ({
      resourceId: p.plan,
      meter: p.tier,
      cost: round2(p.cost),
      reason: `App Service Plan '${p.plan}' on ${p.tier} tier — ${p.rows.length} meter rows in period.`,
    }));

    return [{
      id: "appServiceSavingsPlan",
      category: "lever",
      jeannieRule: 1,
      order: 1,
      title: `App Service Compute Savings Plan — ${plans.length} plans, ${formatMoney(totalCost, invoice.displayCurrency)} eligible spend`,
      severity: "conditional",
      monthlySaving: null,
      annualSaving: null,
      monthlySavingRange: [monthlyLow, monthlyHigh],
      annualSavingRange: [round2(monthlyLow * 12), round2(monthlyHigh * 12)],
      currency: invoice.displayCurrency,
      confidence: "medium",
      evidence,
      narrative: {
        customer:
          `You have ${plans.length} App Service plans running steady-state, costing ` +
          `${formatMoney(totalCost, invoice.displayCurrency)} this period. A 3-year compute Savings Plan ` +
          `cuts that by ${(COMPUTE_SP_DISCOUNT_LOW * 100).toFixed(0)}–${(COMPUTE_SP_DISCOUNT_HIGH * 100).toFixed(0)}% — ` +
          `roughly ${formatMoney(monthlyLow, invoice.displayCurrency)} to ${formatMoney(monthlyHigh, invoice.displayCurrency)} per month. ` +
          `The 3-year term is not a trap: if your hosting needs change, the commitment exchanges ` +
          `dollar-for-dollar onto other Azure compute.`,
        consultant:
          `${plans.length} App Service Plans, ${formatMoney(totalCost, invoice.displayCurrency)} period spend (excludes F-tier consumption). ` +
          `Recommend Compute Savings Plan, 3-year, hourly commit at the steady-state floor. ` +
          `Discount band ${(COMPUTE_SP_DISCOUNT_LOW * 100).toFixed(0)}–${(COMPUTE_SP_DISCOUNT_HIGH * 100).toFixed(0)}% ` +
          `(varies by tier mix — P-tier higher, S-tier lower).`,
        informational:
          `Implements Jeannie Rule 1 (lever order: Savings Plans third) and Rule 5 (3-year terms exchangeable). ` +
          `Saving is presented as a RANGE because Compute SP discount varies by tier. Eligible spend excludes ` +
          `F-tier (free/consumption) lines. Plan-level grouping uses the serverfarms segment of resourceId.`,
      },
      discoveryQuestions: [
        `What's the absolute floor App Service compute commit you'd be comfortable with at 3 years?`,
        `Are any of these plans candidates for retirement or migration to Container Apps before commit?`,
      ],
      effort: "low",
      requiresConfirmation: [
        "Confirm steady-state hourly commit floor",
        "Confirm no scheduled retirement of plans within 12 months",
      ],
    }];
  },
};
