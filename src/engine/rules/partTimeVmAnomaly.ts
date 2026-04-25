/**
 * Rule: VMs running <50% of the period without an obvious schedule.
 * Implements Jeannie Rule 8 (runtime reverse-engineering) — but only as a
 * surfacing signal. We never recommend deletion or scheduling without the
 * humanity question (Jeannie Rule 9).
 */

import type { Finding, ParsedInvoice, Rule, EvidenceRow, InvoiceRow } from "../../types";
import { lookupHourlyRate } from "../rates";
import { round2, formatMoney } from "./_helpers";
import { getFrameworkRule } from "../framework";

function isReservationRow(r: InvoiceRow): boolean {
  return /reservation/i.test(r.meter) || /reservation/i.test(r.serviceName);
}

export const partTimeVmAnomalyRule: Rule = {
  id: "partTimeVmAnomaly",
  name: "Part-time VMs (<50% of period) without obvious schedule",
  framework: { rule: 8, quote: getFrameworkRule(8).statement },

  evaluate(invoice: ParsedInvoice): Finding[] | null {
    const hours = invoice.period.hoursInPeriod;
    type Vm = { resourceId: string; meter: string; loc: string; cost: number; rg: string; rate?: number };
    const map = new Map<string, Vm>();
    for (const r of invoice.rows) {
      if (r.resourceType !== "microsoft.compute/virtualmachines") continue;
      if (r.serviceName !== "Virtual Machines") continue;
      if (isReservationRow(r)) continue;
      const v = map.get(r.resourceId) ?? {
        resourceId: r.resourceId,
        meter: r.meter,
        loc: r.resourceLocation,
        cost: 0,
        rg: r.resourceGroupName,
      };
      v.cost += r.cost;
      map.set(r.resourceId, v);
    }
    const partTime: Array<Vm & { utilisationPct: number; billedHours: number }> = [];
    for (const v of map.values()) {
      const lookup = lookupHourlyRate(v.meter, v.loc);
      if (!lookup || v.cost <= 0) continue;
      const billed = v.cost / lookup.hourlyUsd;
      const pct = (billed / hours) * 100;
      if (pct > 5 && pct < 50) {
        partTime.push({ ...v, billedHours: round2(billed), utilisationPct: round2(pct) });
      }
    }
    if (partTime.length === 0) return null;

    partTime.sort((a, b) => a.utilisationPct - b.utilisationPct);
    const totalCost = round2(partTime.reduce((s, v) => s + v.cost, 0));
    const evidence: EvidenceRow[] = partTime.slice(0, 25).map((v) => ({
      resourceId: v.resourceId,
      meter: v.meter,
      cost: round2(v.cost),
      reason: `${v.billedHours}h billed (${v.utilisationPct}% of ${hours}h period). Looks scheduled or unstable.`,
    }));

    return [{
      id: "partTimeVmAnomaly",
      category: "runtime",
      jeannieRule: 8,
      order: 1,
      title: `Part-time VMs — ${partTime.length} running 5–50% of the period`,
      severity: "investigate",
      monthlySaving: null,
      annualSaving: null,
      currency: invoice.displayCurrency,
      confidence: "medium",
      evidence,
      narrative: {
        customer:
          `${partTime.length} servers were only running for part of the month. That can be a healthy ` +
          `pattern (deliberate dev-hours scheduling) or a warning sign (unstable workload). Worth confirming.`,
        consultant:
          `${partTime.length} VMs derived to 5–50% period utilisation, totalling ${formatMoney(totalCost, invoice.displayCurrency)}. ` +
          `Either there's a scheduler in place (document it) or there's a flap (fix it). ` +
          `Both outcomes affect reservation sizing decisions made by reservationScopeCheck.`,
        informational:
          `Detection: PAYG VMs where billed_hours = cost / hourly_rate falls in the 5–50% band. ` +
          `Lower bound 5% excludes the ambient noise of one-off boots; upper bound 50% leaves always-on ` +
          `VMs (which Jeannie Rule 6 says are EXPECTED). No saving — observational only.`,
      },
      discoveryQuestions: [
        `Are these VMs scheduled (Auto-shutdown, runbooks, Azure Automation), and if so, is the schedule documented?`,
        `If unscheduled, is the VM crashing/restarting and incurring time-of-flap charges?`,
      ],
      effort: "low",
      requiresConfirmation: [],
    }];
  },
};
