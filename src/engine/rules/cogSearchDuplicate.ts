/**
 * Rule: multiple Cognitive Search instances; flag non-prod / PoC for Basic tier.
 */

import type { Finding, ParsedInvoice, Rule, EvidenceRow } from "../../types";
import { round2, formatMoney, isNonProdName, nameFromResourceId } from "./_helpers";

export const cogSearchDuplicateRule: Rule = {
  id: "cogSearchDuplicate",
  name: "Cognitive Search non-prod tier downgrade",
  framework: { rule: 6, quote: "Per-environment search instance is a sprawl pattern." },

  evaluate(invoice: ParsedInvoice): Finding[] | null {
    const rows = invoice.rows.filter(
      (r) =>
        (r.serviceName === "Azure Cognitive Search" ||
         r.serviceName === "Azure AI Search" ||
         r.serviceName === "Cognitive Search") &&
        r.cost > 0
    );
    if (rows.length === 0) return null;

    type S = { id: string; rg: string; cost: number; tier: string; rows: typeof rows };
    const byInst = new Map<string, S>();
    for (const r of rows) {
      const id = nameFromResourceId(r.resourceId);
      const tier = (r.meter.match(/(Basic|Standard\s*S\d|Storage Optimized L\d)/i)?.[1] ?? "?");
      const s = byInst.get(id) ?? { id, rg: r.resourceGroupName, cost: 0, tier, rows: [] };
      s.cost += r.cost;
      s.rows.push(r);
      byInst.set(id, s);
    }
    if (byInst.size < 2) return null; // only flag when ≥2 instances

    const candidates = [...byInst.values()].filter(
      (s) => isNonProdName(`${s.id} ${s.rg}`) && !/basic/i.test(s.tier)
    );
    if (candidates.length === 0) return null;

    const findings: Finding[] = [];
    let order = 1;
    for (const c of candidates) {
      const monthly = round2(c.cost);
      const low = round2(monthly * 0.55);
      const high = round2(monthly * 0.65);
      const evidence: EvidenceRow[] = c.rows.map((r) => ({
        resourceId: r.resourceId,
        meter: r.meter,
        cost: round2(r.cost),
        reason: `Cognitive Search '${c.id}' on '${c.tier}' in non-prod-named context.`,
      }));
      findings.push({
        id: `cogSearchDuplicate:${c.id}`,
        category: "anomaly",
        jeannieRule: 6,
        order: order++,
        title: `Cognitive Search '${c.id}' — non-prod on ${c.tier}, candidate for Basic`,
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
            `Cognitive Search '${c.id}' is on ${c.tier} in a non-prod environment, costing ` +
            `${formatMoney(monthly, invoice.displayCurrency)}/month. Basic tier is fine for non-prod testing ` +
            `and would save ${formatMoney(low, invoice.displayCurrency)}–${formatMoney(high, invoice.displayCurrency)}/month.`,
          consultant:
            `Search '${c.id}', ${c.tier}, non-prod RG '${c.rg}'. Basic tier limits: 2GB index size, ` +
            `3 partitions, 3 replicas. Validate index size and replica needs before downgrade.`,
          informational:
            `Detection: ≥2 Cognitive Search instances; flag non-prod-named ones not already on Basic. ` +
            `Saving estimated at 60% (Basic ≈ 40% of Standard S1 list price).`,
        },
        discoveryQuestions: [
          `Is the index size on '${c.id}' under 2GB and likely to stay that way?`,
          `Is high availability required in this non-prod environment?`,
        ],
        effort: "medium",
        requiresConfirmation: ["Index size measurement", "Re-create on Basic (no in-place downgrade)"],
      });
    }
    return findings.length > 0 ? findings : null;
  },
};
