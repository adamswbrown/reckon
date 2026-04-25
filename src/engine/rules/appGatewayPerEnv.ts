/**
 * Rule: App Gateway consolidation candidate.
 * If >5 distinct Application Gateways exist, flag consolidation opportunity.
 */

import type { Finding, ParsedInvoice, Rule, EvidenceRow } from "../../types";
import { round2, formatMoney, nameFromResourceId } from "./_helpers";

export const appGatewayPerEnvRule: Rule = {
  id: "appGatewayPerEnv",
  name: "App Gateway consolidation candidate",
  framework: { rule: 6, quote: "More-than-needed gateways are a sprawl signal." },

  evaluate(invoice: ParsedInvoice): Finding[] | null {
    const rows = invoice.rows.filter(
      (r) => r.resourceType === "microsoft.network/applicationgateways" && r.cost > 0
    );
    if (rows.length === 0) return null;

    const distinct = new Map<string, number>();
    for (const r of rows) {
      distinct.set(r.resourceId, (distinct.get(r.resourceId) ?? 0) + r.cost);
    }
    if (distinct.size <= 5) return null;

    const total = round2([...distinct.values()].reduce((s, c) => s + c, 0));
    const monthlyLow = round2(total * 0.2);
    const monthlyHigh = round2(total * 0.5);

    const evidence: EvidenceRow[] = [...distinct.entries()].slice(0, 10).map(([id, cost]) => ({
      resourceId: id,
      meter: "Application Gateway",
      cost: round2(cost),
      reason: `Distinct App Gateway — '${nameFromResourceId(id)}'.`,
    }));

    return [{
      id: "appGatewayPerEnv",
      category: "anomaly",
      jeannieRule: 6,
      order: 1,
      title: `App Gateway consolidation — ${distinct.size} distinct gateways, ${formatMoney(total, invoice.displayCurrency)}/period`,
      severity: "conditional",
      monthlySaving: null,
      annualSaving: null,
      monthlySavingRange: [monthlyLow, monthlyHigh],
      annualSavingRange: [round2(monthlyLow * 12), round2(monthlyHigh * 12)],
      currency: invoice.displayCurrency,
      confidence: "low",
      evidence,
      narrative: {
        customer:
          `You have ${distinct.size} Application Gateways running, costing ${formatMoney(total, invoice.displayCurrency)} ` +
          `a month between them. Often some of those can be consolidated into a shared gateway per environment. ` +
          `High-effort change, but ${formatMoney(monthlyLow, invoice.displayCurrency)}–${formatMoney(monthlyHigh, invoice.displayCurrency)}/month ` +
          `is achievable.`,
        consultant:
          `${distinct.size} distinct App Gateways. Consolidation candidates depend on listener/routing rule overlap ` +
          `and whether WAF policies can be unified. Saving estimated at 20–50% of total spend (varies with listener density).`,
        informational:
          `Detection: distinct microsoft.network/applicationgateways resourceIds > 5. Saving range is heuristic — ` +
          `discovery questions are mandatory per Rule 9.`,
      },
      discoveryQuestions: [
        `Are these gateways deployed one-per-environment, one-per-service, or something else?`,
        `Do the listeners across gateways overlap, or are they fully orthogonal?`,
        `Is WAF policy shared across the gateways or customised per gateway?`,
      ],
      effort: "high",
      requiresConfirmation: [
        "Listener/routing rule audit",
        "WAF policy consolidation plan",
        "Network team sign-off",
      ],
    }];
  },
};
