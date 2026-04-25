/**
 * Rule: VPN Gateway on AZ tier (zone-redundant) — flag for review.
 * AZ tier is ~1.5–2× the cost of non-AZ. If the gateway is for VDI / dev /
 * non-critical connectivity, AZ may be over-engineered.
 */

import type { Finding, ParsedInvoice, Rule, EvidenceRow } from "../../types";
import { round2, formatMoney, nameFromResourceId } from "./_helpers";

export const vpnGatewayAzReviewRule: Rule = {
  id: "vpnGatewayAzReview",
  name: "VPN Gateway AZ tier review",
  framework: { rule: 7, quote: "Cannot prove from billing whether AZ is required — investigate." },

  evaluate(invoice: ParsedInvoice): Finding[] | null {
    const rows = invoice.rows.filter(
      (r) =>
        r.serviceName === "VPN Gateway" &&
        /az$/i.test(r.meter)
    );
    if (rows.length === 0) return null;

    type G = { id: string; cost: number; meter: string; rows: typeof rows };
    const byGw = new Map<string, G>();
    for (const r of rows) {
      const id = nameFromResourceId(r.resourceId);
      const g = byGw.get(id) ?? { id, cost: 0, meter: r.meter, rows: [] };
      g.cost += r.cost;
      g.rows.push(r);
      byGw.set(id, g);
    }

    const findings: Finding[] = [];
    let order = 1;
    for (const g of byGw.values()) {
      const monthly = round2(g.cost);
      if (monthly < 5) continue;
      const low = round2(monthly * 0.30);
      const high = round2(monthly * 0.45);
      const evidence: EvidenceRow[] = g.rows.map((r) => ({
        resourceId: r.resourceId,
        meter: r.meter,
        cost: round2(r.cost),
        reason: `VPN Gateway on AZ tier (${r.meter}) — premium for zone redundancy.`,
      }));
      findings.push({
        id: `vpnGatewayAzReview:${g.id}`,
        category: "anomaly",
        jeannieRule: 7,
        order: order++,
        title: `VPN Gateway AZ-tier review — ${g.id} (${formatMoney(monthly, invoice.displayCurrency)}/period)`,
        severity: "conditional",
        monthlySaving: null,
        annualSaving: null,
        monthlySavingRange: [low, high],
        annualSavingRange: [round2(low * 12), round2(high * 12)],
        currency: invoice.displayCurrency,
        confidence: "low",
        evidence,
        narrative: {
          customer:
            `VPN Gateway '${g.id}' is on the zone-redundant (AZ) SKU, costing ${formatMoney(monthly, invoice.displayCurrency)} a month. ` +
            `If this gateway isn't carrying production-critical traffic, the non-AZ equivalent saves around ` +
            `${formatMoney(low, invoice.displayCurrency)}–${formatMoney(high, invoice.displayCurrency)}/month.`,
          consultant:
            `VPN Gateway '${g.id}' on ${g.meter}. AZ tier ~40% premium over non-AZ. Validate the connectivity SLA ` +
            `requirement — if it's VDI inbound only, non-AZ is usually acceptable.`,
          informational:
            `Detection: VPN Gateway rows with meter ending in 'AZ'. Saving heuristic 40% of current spend. ` +
            `Per Jeannie Rule 7, the invoice cannot prove the SLA requirement — discovery question is mandatory.`,
        },
        discoveryQuestions: [
          `Does '${g.id}' carry production-critical traffic with a zone-redundancy SLA?`,
          `Is this VPN inbound for end-user VDI/RDP, or site-to-site for production data?`,
        ],
        effort: "medium",
        requiresConfirmation: ["Network SLA review", "Re-deploy is required (no in-place SKU change)"],
      });
    }
    return findings;
  },
};
