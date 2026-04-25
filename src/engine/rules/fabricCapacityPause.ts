/**
 * Rule: Microsoft Fabric capacity pause-schedule modelling.
 * Models 3 scenarios: pause overnight (12h/day off), pause weekends (48h/week off),
 * and pause both. Implements Jeannie Rule 9 (discovery question on batch jobs).
 *
 * Severity: `conditional` — pausing breaks anything that runs during the pause window.
 */

import type { Finding, ParsedInvoice, Rule, EvidenceRow } from "../../types";
import { round2, formatMoney, nameFromResourceId } from "./_helpers";

export const fabricCapacityPauseRule: Rule = {
  id: "fabricCapacityPause",
  name: "Microsoft Fabric capacity pause schedule",
  framework: { rule: 9, quote: "Pause modelling requires the batch-job question." },

  evaluate(invoice: ParsedInvoice): Finding[] | null {
    const fabricRows = invoice.rows.filter(
      (r) =>
        r.serviceName === "Microsoft Fabric" &&
        /capacity usage cu/i.test(r.meter)
    );
    if (fabricRows.length === 0) return null;

    type Cap = { id: string; cost: number; rows: typeof fabricRows };
    const byCap = new Map<string, Cap>();
    for (const r of fabricRows) {
      const id = nameFromResourceId(r.resourceId);
      const c = byCap.get(id) ?? { id, cost: 0, rows: [] };
      c.cost += r.cost;
      c.rows.push(r);
      byCap.set(id, c);
    }

    const findings: Finding[] = [];
    let order = 1;
    for (const c of byCap.values()) {
      const monthly = round2(c.cost);
      if (monthly < 1) continue;
      const overnight = round2(monthly * (12 / 24));     // pause 12h/day
      const weekends = round2(monthly * (48 / 168));     // pause 48h/week
      const both = round2(monthly * (12 / 24 + 24 * 2 / 168 - (12 / 24) * (48 / 168)));

      const evidence: EvidenceRow[] = c.rows.slice(0, 10).map((r) => ({
        resourceId: r.resourceId,
        meter: r.meter,
        cost: round2(r.cost),
        reason: `Fabric CU usage on '${c.id}'.`,
      }));

      findings.push({
        id: `fabricCapacityPause:${c.id}`,
        category: "anomaly",
        jeannieRule: 9,
        order: order++,
        title: `Fabric capacity pause schedule — ${c.id} (${formatMoney(monthly, invoice.displayCurrency)}/period)`,
        severity: "conditional",
        monthlySaving: null,
        annualSaving: null,
        monthlySavingRange: [overnight, both],
        annualSavingRange: [round2(overnight * 12), round2(both * 12)],
        currency: invoice.displayCurrency,
        confidence: "medium",
        evidence,
        narrative: {
          customer:
            `Fabric capacity '${c.id}' costs ${formatMoney(monthly, invoice.displayCurrency)} a month and ` +
            `runs continuously. If your reporting users are office-hours only, pausing overnight saves ` +
            `${formatMoney(overnight, invoice.displayCurrency)}/month; pausing weekends as well saves about ` +
            `${formatMoney(both, invoice.displayCurrency)}/month.`,
          consultant:
            `Fabric capacity '${c.id}', ${formatMoney(monthly, invoice.displayCurrency)} period spend. ` +
            `Three pause scenarios modelled: overnight (12h/d), weekends (48h/w), both (~67% off). ` +
            `Resume time is sub-minute. Affects scheduled refreshes — must coordinate with data factory schedules.`,
          informational:
            `Detection: Microsoft Fabric service rows with 'capacity usage cu' meters. Three pause scenarios ` +
            `linearly extrapolated from monthly cost. Range presented (overnight floor → both ceiling) per Rule 10 ` +
            `pattern: ambiguous saves stay ambiguous.`,
        },
        discoveryQuestions: [
          `Are there overnight or weekend batch jobs (Data Factory, Synapse pipelines) that depend on '${c.id}'?`,
          `Is the dataset refresh schedule compatible with a pause window?`,
          `Who owns the pause/resume runbook — platform team or workload team?`,
        ],
        effort: "low",
        requiresConfirmation: [
          "Confirm batch schedule does not cross pause window",
          "Coordinate with Power BI / dataset owners",
        ],
      });
    }
    return findings.length > 0 ? findings : null;
  },
};
