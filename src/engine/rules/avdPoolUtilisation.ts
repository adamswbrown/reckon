/**
 * Rule: AVD/VDI session host pool utilisation observation.
 *
 * Detection
 * ---------
 * VMs whose RG name or VM name suggests AVD: contains 'avd', 'vdi',
 * 'sessionhost', 'wvd', or 'desktop'. We compute the fleet PAYG vs reservation
 * coverage and report the ceiling utilisation derived from cost (Jeannie
 * Rule 8). Per Jeannie Rule 6, under-utilisation in pools is HEALTHY — we
 * present this as an observation, not a saving.
 *
 * Severity: `investigate`. The point is to make pool sizing visible, not
 * to chase a saving.
 */

import type { Finding, ParsedInvoice, Rule, EvidenceRow, InvoiceRow } from "../../types";
import { lookupHourlyRate } from "../rates";
import { round2, formatMoney } from "./_helpers";
import { getFrameworkRule } from "../framework";

const AVD_TOKENS = ["avd", "vdi", "sessionhost", "wvd", "desktop"];

function looksLikeAvd(r: InvoiceRow): boolean {
  if (r.resourceType !== "microsoft.compute/virtualmachines") return false;
  const haystack = `${r.resourceId} ${r.resourceGroupName}`.toLowerCase();
  return AVD_TOKENS.some((t) => haystack.includes(t));
}

function isReservationRow(r: InvoiceRow): boolean {
  return /reservation/i.test(r.meter) || /reservation/i.test(r.serviceName);
}

export const avdPoolUtilisationRule: Rule = {
  id: "avdPoolUtilisation",
  name: "AVD pool utilisation observation",
  framework: { rule: 6, quote: getFrameworkRule(6).statement },

  evaluate(invoice: ParsedInvoice): Finding[] | null {
    const avdRows = invoice.rows.filter(looksLikeAvd);
    if (avdRows.length === 0) return null;

    // Group by RG so we report per-pool.
    type Pool = {
      rg: string;
      vmIds: Set<string>;
      paygCost: number;
      reservationRows: number;
      principalRow?: InvoiceRow;
    };
    const byRg = new Map<string, Pool>();
    for (const r of avdRows) {
      const p = byRg.get(r.resourceGroupName) ?? {
        rg: r.resourceGroupName,
        vmIds: new Set<string>(),
        paygCost: 0,
        reservationRows: 0,
      };
      p.vmIds.add(r.resourceId);
      if (isReservationRow(r)) p.reservationRows++;
      else if (r.serviceName === "Virtual Machines") p.paygCost += r.cost;
      if (!p.principalRow && r.serviceName === "Virtual Machines") p.principalRow = r;
      byRg.set(r.resourceGroupName, p);
    }

    const hours = invoice.period.hoursInPeriod;
    const findings: Finding[] = [];
    let order = 1;
    for (const p of byRg.values()) {
      const lookup = p.principalRow
        ? lookupHourlyRate(p.principalRow.meter, p.principalRow.resourceLocation)
        : null;
      const ceilingHours =
        lookup && p.vmIds.size > 0 ? p.paygCost / lookup.hourlyUsd : null;
      const ceilingPctPerVm =
        ceilingHours !== null ? round2((ceilingHours / (hours * p.vmIds.size)) * 100) : null;

      const evidence: EvidenceRow[] = [
        {
          resourceId: p.rg,
          meter: p.principalRow?.meter ?? "(no compute meter)",
          cost: round2(p.paygCost),
          reason:
            ceilingPctPerVm !== null
              ? `${p.vmIds.size} session hosts, fleet ceiling ~${ceilingPctPerVm}% per host across the period.`
              : `${p.vmIds.size} session hosts; rate not in table — utilisation not derivable.`,
        },
      ];

      findings.push({
        id: `avdPoolUtilisation:${p.rg}`,
        category: "runtime",
        jeannieRule: 6,
        order: order++,
        title: `AVD pool '${p.rg}' — ${p.vmIds.size} session hosts (${ceilingPctPerVm !== null ? `${ceilingPctPerVm}% fleet ceiling` : "rate unknown"})`,
        severity: "investigate",
        monthlySaving: null,
        annualSaving: null,
        currency: invoice.displayCurrency,
        confidence: "low",
        evidence,
        narrative: {
          customer:
            `RG '${p.rg}' looks like an AVD/desktop pool with ${p.vmIds.size} session hosts. ` +
            `It's normal — and healthy — for these to run at low utilisation; spare capacity is what makes ` +
            `logins fast at the start of the working day.`,
          consultant:
            `AVD/VDI pool in RG '${p.rg}', ${p.vmIds.size} VMs, ` +
            `${ceilingPctPerVm !== null ? `${ceilingPctPerVm}% fleet ceiling` : "ceiling not derivable"}. ` +
            `Per Jeannie Rule 6, under-utilisation in pools is desired behaviour. Consider Stop on Disconnect / Auto-scale plan ` +
            `if the ceiling is nowhere near 100% during business hours.`,
          informational:
            `Detection: VM rows with 'avd', 'vdi', 'sessionhost', 'wvd', 'desktop' in resourceId/RG. ` +
            `Ceiling = paygCost / hourlyRate / vmCount / hoursInPeriod. No saving claim — this is observational.`,
        },
        discoveryQuestions: [
          `Is the AVD scaling plan in place for this pool, and does it ramp down outside business hours?`,
          `Are session hosts pinned to a specific SKU for app compatibility, or could the pool downsize?`,
        ],
        effort: "medium",
        requiresConfirmation: [],
      });
    }
    return findings.length > 0 ? findings : null;
  },
};
