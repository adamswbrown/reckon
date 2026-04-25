/**
 * Rule: Private endpoint sprawl in non-prod resource groups.
 * Implements Jeannie Rule 6 (sprawl) + Rule 9 (discovery question on
 * security posture).
 */

import type { Finding, ParsedInvoice, Rule, EvidenceRow } from "../../types";
import { round2, formatMoney, isNonProdName } from "./_helpers";

export const privateEndpointSprawlRule: Rule = {
  id: "privateEndpointSprawl",
  name: "Private endpoint sprawl in non-prod RGs",
  framework: { rule: 6, quote: "Sprawl tends to appear in non-prod first." },

  evaluate(invoice: ParsedInvoice): Finding[] | null {
    const peRows = invoice.rows.filter(
      (r) =>
        r.serviceName === "Virtual Network" &&
        /private endpoint/i.test(r.meter)
    );
    if (peRows.length === 0) return null;

    type Bucket = { rg: string; cost: number; count: number; rows: typeof peRows };
    const byRg = new Map<string, Bucket>();
    for (const r of peRows) {
      if (!isNonProdName(r.resourceGroupName)) continue;
      const b = byRg.get(r.resourceGroupName) ?? { rg: r.resourceGroupName, cost: 0, count: 0, rows: [] };
      b.cost += r.cost;
      b.count++;
      b.rows.push(r);
      byRg.set(r.resourceGroupName, b);
    }
    if (byRg.size === 0) return null;

    const findings: Finding[] = [];
    let order = 1;
    for (const b of byRg.values()) {
      // Include ALL evidence rows so the validator can reconcile the
      // claimed saving (= full Service Endpoint replacement cost) against
      // the per-row cost. Slicing here would silently drop evidence and
      // trigger EVIDENCE_RECONCILIATION_MISMATCH.
      const evidence: EvidenceRow[] = b.rows.map((r) => ({
        resourceId: r.resourceId,
        meter: r.meter,
        cost: round2(r.cost),
        reason: `Private endpoint in non-prod RG '${b.rg}'.`,
      }));
      // Use the sum of ROUNDED evidence costs as the saving claim — this
      // makes the reconciliation arithmetic match exactly (sub-cent drift
      // would otherwise trip EVIDENCE_RECONCILIATION_MISMATCH).
      const monthly = round2(evidence.reduce((s, e) => s + e.cost, 0));
      if (monthly < 1) continue;
      findings.push({
        id: `privateEndpointSprawl:${b.rg}`,
        category: "anomaly",
        jeannieRule: 6,
        order: order++,
        title: `Private endpoint sprawl in '${b.rg}' — ${b.count} endpoints, ${formatMoney(monthly, invoice.displayCurrency)}/period`,
        severity: "conditional",
        monthlySaving: monthly,
        annualSaving: round2(monthly * 12),
        currency: invoice.displayCurrency,
        confidence: "medium",
        evidence,
        narrative: {
          customer:
            `Resource group '${b.rg}' (looks like a non-production environment) has ${b.count} private endpoints ` +
            `costing ${formatMoney(monthly, invoice.displayCurrency)} a month. For non-prod, Service Endpoints ` +
            `usually do the same job at almost no cost.`,
          consultant:
            `${b.count} Standard Private Endpoints in '${b.rg}' — non-prod naming. Service Endpoints offer ` +
            `equivalent VNet integration for most PaaS services in non-prod scenarios. Confirm no compliance ` +
            `requirement before swap.`,
          informational:
            `Detection: Virtual Network rows with meter matching /private endpoint/i, grouped by RG, filtered to ` +
            `non-prod RG names (per _helpers/isNonProdName). Saving = full endpoint cost (Service Endpoints are free).`,
        },
        discoveryQuestions: [
          `Does '${b.rg}' have a compliance requirement that mandates Private Endpoint over Service Endpoint?`,
          `Are any of these endpoints connected to PaaS services (e.g. Storage, KeyVault) where Service Endpoints would suffice?`,
        ],
        effort: "medium",
        requiresConfirmation: ["Network security review before endpoint swap"],
      });
    }
    return findings.length > 0 ? findings : null;
  },
};
