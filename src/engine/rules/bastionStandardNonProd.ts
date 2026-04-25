/**
 * Rule: Azure Bastion on Standard tier in non-prod RGs.
 * Severity: `confirmed` (downgrade is reversible and the saving is precise),
 * effort: `low`.
 */

import type { Finding, ParsedInvoice, Rule, EvidenceRow } from "../../types";
import { round2, formatMoney, isNonProdName, nameFromResourceId } from "./_helpers";

export const bastionStandardNonProdRule: Rule = {
  id: "bastionStandardNonProd",
  name: "Bastion Standard tier in non-prod",
  framework: { rule: 10, quote: "Confirmed — downgrade reversible and saving precise." },

  evaluate(invoice: ParsedInvoice): Finding[] | null {
    const rows = invoice.rows.filter(
      (r) =>
        r.serviceName === "Azure Bastion" &&
        /standard gateway/i.test(r.meter)
    );
    if (rows.length === 0) return null;

    type B = { id: string; cost: number; rg: string; rows: typeof rows };
    const byHost = new Map<string, B>();
    for (const r of rows) {
      if (!isNonProdName(`${r.resourceId} ${r.resourceGroupName}`)) continue;
      const id = nameFromResourceId(r.resourceId);
      const b = byHost.get(id) ?? { id, cost: 0, rg: r.resourceGroupName, rows: [] };
      b.cost += r.cost;
      b.rows.push(r);
      byHost.set(id, b);
    }
    if (byHost.size === 0) return null;

    const findings: Finding[] = [];
    let order = 1;
    for (const b of byHost.values()) {
      const monthly = round2(b.cost);
      // Standard is roughly 2x Basic. Use a tight range — list-price tier delta.
      const low = round2(monthly * 0.45);
      const high = round2(monthly * 0.55);
      const evidence: EvidenceRow[] = b.rows.map((r) => ({
        resourceId: r.resourceId,
        meter: r.meter,
        cost: round2(r.cost),
        reason: `Bastion Standard Gateway in non-prod RG '${b.rg}'.`,
      }));
      findings.push({
        id: `bastionStandardNonProd:${b.id}`,
        category: "anomaly",
        jeannieRule: 10,
        order: order++,
        title: `Bastion Standard → Basic in '${b.rg}' (~${formatMoney(low, invoice.displayCurrency)}–${formatMoney(high, invoice.displayCurrency)}/mo)`,
        severity: "conditional",
        monthlySaving: null,
        annualSaving: null,
        monthlySavingRange: [low, high],
        annualSavingRange: [round2(low * 12), round2(high * 12)],
        currency: invoice.displayCurrency,
        confidence: "high",
        evidence,
        narrative: {
          customer:
            `Azure Bastion '${b.id}' is on Standard tier in non-prod, costing ${formatMoney(monthly, invoice.displayCurrency)} a month. ` +
            `Basic tier covers everything most non-prod estates need and saves around ` +
            `${formatMoney(low, invoice.displayCurrency)}–${formatMoney(high, invoice.displayCurrency)}/month.`,
          consultant:
            `Bastion '${b.id}' Standard tier in '${b.rg}' (non-prod). Downgrade to Basic via re-deploy ` +
            `(downgrade is not in-place). Standard-only features lost: shareable links, native client, IP-based connection.`,
          informational:
            `Detection: 'Standard Gateway' meter in non-prod-named RG. Saving uses Standard ≈ 2× Basic. ` +
            `Severity 'confirmed' — the action is reversible and the saving is the difference between two list-price tiers.`,
        },
        discoveryQuestions: [
          `Is anyone using Bastion shareable links, native-client, or IP-based connect on '${b.id}'?`,
        ],
        effort: "low",
        requiresConfirmation: ["Confirm no Standard-only feature in use"],
      });
    }
    return findings;
  },
};
