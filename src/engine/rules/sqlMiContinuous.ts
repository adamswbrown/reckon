/**
 * Rule: SQL Managed Instance running continuously in non-prod RGs.
 * Recommends a stop/start schedule.
 */

import type { Finding, ParsedInvoice, Rule, EvidenceRow } from "../../types";
import { round2, formatMoney, isNonProdName, nameFromResourceId } from "./_helpers";

export const sqlMiContinuousRule: Rule = {
  id: "sqlMiContinuous",
  name: "SQL Managed Instance non-prod stop/start candidate",
  framework: { rule: 6, quote: "Non-prod always-on is the textbook sprawl pattern." },

  evaluate(invoice: ParsedInvoice): Finding[] | null {
    const rows = invoice.rows.filter(
      (r) =>
        /microsoft\.sql\/managedinstances/i.test(r.resourceType) &&
        r.cost > 0
    );
    if (rows.length === 0) return null;

    type Mi = { id: string; cost: number; rg: string; rows: typeof rows };
    const byMi = new Map<string, Mi>();
    for (const r of rows) {
      if (!isNonProdName(`${r.resourceId} ${r.resourceGroupName}`)) continue;
      const id = nameFromResourceId(r.resourceId.split("/managedInstances/")[1]?.split("/")[0] ?? r.resourceId);
      const m = byMi.get(id) ?? { id, cost: 0, rg: r.resourceGroupName, rows: [] };
      m.cost += r.cost;
      m.rows.push(r);
      byMi.set(id, m);
    }
    if (byMi.size === 0) return null;

    const findings: Finding[] = [];
    let order = 1;
    for (const m of byMi.values()) {
      const monthly = round2(m.cost);
      // Pause overnight + weekends: 60–70% off depending on schedule density.
      const low = round2(monthly * 0.60);
      const high = round2(monthly * 0.70);
      const evidence: EvidenceRow[] = m.rows.slice(0, 10).map((r) => ({
        resourceId: r.resourceId,
        meter: r.meter,
        cost: round2(r.cost),
        reason: `SQL MI '${m.id}' in non-prod RG '${m.rg}'.`,
      }));
      findings.push({
        id: `sqlMiContinuous:${m.id}`,
        category: "anomaly",
        jeannieRule: 6,
        order: order++,
        title: `SQL MI stop/start candidate — ${m.id} (${formatMoney(monthly, invoice.displayCurrency)}/period)`,
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
            `SQL Managed Instance '${m.id}' (in non-prod RG '${m.rg}') runs continuously and costs ` +
            `${formatMoney(monthly, invoice.displayCurrency)} a month. Stop/start outside business hours typically ` +
            `saves ${formatMoney(low, invoice.displayCurrency)}–${formatMoney(high, invoice.displayCurrency)}/month (60–70%).`,
          consultant:
            `SQL MI '${m.id}', ${formatMoney(monthly, invoice.displayCurrency)} period spend. Stop/start ` +
            `via Az PowerShell or Logic App. Note: SQL MI start can take 5–10 minutes — schedule needs to ` +
            `lead the working day.`,
          informational:
            `Detection: microsoft.sql/managedinstances resources in non-prod RGs. Saving uses 65% (overnight 12h ` +
            `+ weekends 48h ≈ 60–70% off-time). Manual stop/start procedure required — no native scheduler in MI.`,
        },
        discoveryQuestions: [
          `Are there overnight or weekend processes (ETL, reports, integration tests) that need '${m.id}' available?`,
          `Who owns the stop/start automation — DBA team or platform team?`,
        ],
        effort: "medium",
        requiresConfirmation: [
          "Confirm no out-of-hours dependencies",
          "Stop/start runbook tested with the dataset",
        ],
      });
    }
    return findings;
  },
};
