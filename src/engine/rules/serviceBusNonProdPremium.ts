/**
 * Rule: Premium Service Bus namespaces in non-prod environments.
 * Severity: `conditional` — Premium may be required for VNet integration.
 */

import type { Finding, ParsedInvoice, Rule, EvidenceRow } from "../../types";
import { round2, formatMoney, isNonProdName, nameFromResourceId } from "./_helpers";

export const serviceBusNonProdPremiumRule: Rule = {
  id: "serviceBusNonProdPremium",
  name: "Premium Service Bus in non-prod",
  framework: { rule: 9, quote: "Premium → Standard requires the VNet question." },

  evaluate(invoice: ParsedInvoice): Finding[] | null {
    const rows = invoice.rows.filter(
      (r) =>
        r.serviceName === "Service Bus" &&
        /premium/i.test(r.meter)
    );
    if (rows.length === 0) return null;

    type Ns = { name: string; rg: string; cost: number; rows: typeof rows };
    const byNs = new Map<string, Ns>();
    for (const r of rows) {
      const name = nameFromResourceId(r.resourceId.split("/namespaces/")[1]?.split("/")[0] ?? r.resourceId);
      const haystack = `${name} ${r.resourceGroupName}`;
      if (!isNonProdName(haystack)) continue;
      const ns = byNs.get(name) ?? { name, rg: r.resourceGroupName, cost: 0, rows: [] };
      ns.cost += r.cost;
      ns.rows.push(r);
      byNs.set(name, ns);
    }
    if (byNs.size === 0) return null;

    const findings: Finding[] = [];
    let order = 1;
    for (const ns of byNs.values()) {
      const monthly = round2(ns.cost);
      if (monthly < 5) continue;
      const evidence: EvidenceRow[] = ns.rows.map((r) => ({
        resourceId: r.resourceId,
        meter: r.meter,
        cost: round2(r.cost),
        reason: `Premium Service Bus messaging unit in non-prod-named namespace.`,
      }));
      const low = round2(monthly * 0.80);
      const high = round2(monthly * 0.90);
      findings.push({
        id: `serviceBusNonProdPremium:${ns.name}`,
        category: "anomaly",
        jeannieRule: 9,
        order: order++,
        title: `Premium Service Bus in non-prod — ${ns.name} (${formatMoney(monthly, invoice.displayCurrency)}/period)`,
        severity: "conditional",
        monthlySaving: null,
        annualSaving: null,
        monthlySavingRange: [low, high],
        annualSavingRange: [round2(low * 12), round2(high * 12)],
        currency: invoice.displayCurrency,
        confidence: "medium",
        evidence,
        narrative: {
          customer:
            `Service Bus namespace '${ns.name}' is on the Premium tier in what looks like a non-production ` +
            `environment, costing ${formatMoney(monthly, invoice.displayCurrency)} a month. Standard tier would ` +
            `do the same job for a fraction of the cost — unless you specifically need VNet integration.`,
          consultant:
            `Premium SB namespace '${ns.name}' in non-prod-named RG '${ns.rg}'. ` +
            `Saving estimate ~85% (Premium MU is roughly 7–10× Standard for equivalent throughput). ` +
            `Validate VNet integration / private link requirement before downgrade.`,
          informational:
            `Detection: Service Bus rows with 'premium' in meter, namespace or RG matching non-prod tokens. ` +
            `Saving estimate uses 85% (typical) — refresh against Standard tier list price for production reports.`,
        },
        discoveryQuestions: [
          `Does '${ns.name}' use Premium-only features (VNet integration, geo-DR, dedicated capacity)?`,
          `Is the throughput in this namespace within Standard's per-namespace limits?`,
        ],
        effort: "medium",
        requiresConfirmation: ["Confirm no VNet/private endpoint dependency"],
      });
    }
    return findings.length > 0 ? findings : null;
  },
};
