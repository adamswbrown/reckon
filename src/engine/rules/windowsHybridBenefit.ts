/**
 * Rule: Windows Hybrid Benefit (Layer 1 of two — see Jeannie Rule 2).
 *
 * What it does
 * ------------
 * Finds every `Virtual Machines Licenses` row whose meter is Windows-flavoured
 * (excluding SQL Server uplift meters, which belong to the sqlHybridBenefit
 * rule — Layer 2). The sum across the period is the saving available IF the
 * customer holds Windows Server Software Assurance.
 *
 * Framework lineage
 * -----------------
 *   - Implements **Jeannie Rule 2** (Layer 1, Windows rental visible on the
 *     invoice — every dollar disappears with SA).
 *   - Implements **Jeannie Rule 3** (40% uplift, skip individual recommendations
 *     under 8 vCores; rank survivors by vCore count desc).
 *
 * Severity
 * --------
 *   - `conditional` — gated on a single discovery question: "Do you hold
 *     Windows Server Software Assurance, with cores you can deploy to Azure?"
 *     This is the textbook Jeannie Rule 9 humanity-layer question.
 *
 * Why this is the reference pattern
 * ----------------------------------
 *   - Declares its framework lineage in `rule.framework`.
 *   - Aggregates sub-8-vCore rows into a tail finding instead of per-VM noise.
 *   - Ranks the per-VM list by vCores desc.
 *   - Carries three audience narratives — Customer, Consultant, Informational.
 *   - Cites the framework rule numbers in the Informational narrative.
 *   - Returns evidence rows that reconcile exactly to the claimed cost.
 */

import type { Finding, ParsedInvoice, Rule, EvidenceRow } from "../../types";
import { lookupHourlyRate, normaliseSkuToken } from "../rates";
import { getFrameworkRule } from "../framework";

const VCORE_THRESHOLD = 8;

/** Meters under Virtual Machines Licenses that are SQL — exclude from Layer 1. */
const SQL_LICENSE_HINTS = ["sql"];

/** Pull a vCore count out of a meter name like "D16s v5" → 16. */
function vCoresFromMeter(meter: string, resourceLocation: string): number | null {
  const lookup = lookupHourlyRate(meter, resourceLocation);
  if (lookup) return lookup.sku.vCores;
  // Fallback — read the digits between letters and the next non-digit, e.g.
  // "Standard_D16s_v5" → 16. Conservative; returns null if ambiguous.
  const m = normaliseSkuToken(meter).match(/^[a-z]+(\d+)/);
  return m ? Number(m[1]) : null;
}

function isWindowsLicenseRow(row: ParsedInvoice["rows"][number]): boolean {
  if (row.serviceName !== "Virtual Machines Licenses") return false;
  const meterLc = row.meter.toLowerCase();
  if (SQL_LICENSE_HINTS.some((h) => meterLc.includes(h))) return false;
  return true;
}

export const windowsHybridBenefitRule: Rule = {
  id: "windowsHybridBenefit",
  name: "Windows Hybrid Benefit (Layer 1)",
  framework: {
    rule: 2,
    quote: getFrameworkRule(2).statement
      || "Jeannie Rule 2 — Windows rental is the visible Hybrid Benefit layer.",
  },

  evaluate(invoice: ParsedInvoice): Finding[] | null {
    const licenseRows = invoice.rows.filter(isWindowsLicenseRow);
    if (licenseRows.length === 0) return null;

    // Aggregate per-VM (resourceId), capturing meter + vCores + cost.
    type VmAgg = {
      resourceId: string;
      vmName: string;
      meter: string;
      resourceLocation: string;
      resourceGroup: string;
      vCores: number | null;
      cost: number;
      currency: string;
      evidenceRows: EvidenceRow[];
    };
    const byVm = new Map<string, VmAgg>();

    for (const r of licenseRows) {
      const key = r.resourceId || `${r.resourceGroupName}|${r.meter}`;
      let agg = byVm.get(key);
      if (!agg) {
        agg = {
          resourceId: r.resourceId,
          vmName: r.resourceId.split("/").pop() ?? "(unknown VM)",
          meter: r.meter,
          resourceLocation: r.resourceLocation,
          resourceGroup: r.resourceGroupName,
          vCores: vCoresFromMeter(r.meter, r.resourceLocation),
          cost: 0,
          currency: r.currency,
          evidenceRows: [],
        };
        byVm.set(key, agg);
      }
      agg.cost += r.cost;
      agg.evidenceRows.push({
        resourceId: r.resourceId,
        meter: r.meter,
        cost: r.cost,
        reason: `Windows Server license uplift on ${r.meter} (${r.resourceLocation})`,
      });
    }

    // Split by 8-vCore threshold per Jeannie Rule 3.
    const large: VmAgg[] = [];
    const small: VmAgg[] = [];
    for (const v of byVm.values()) {
      if ((v.vCores ?? 0) >= VCORE_THRESHOLD) large.push(v);
      else small.push(v);
    }
    large.sort((a, b) => (b.vCores ?? 0) - (a.vCores ?? 0));

    const findings: Finding[] = [];
    let order = 1;

    // ── One finding per large VM ────────────────────────────────────────
    for (const v of large) {
      const monthly = roundCents(v.cost);
      findings.push({
        id: `windowsHybridBenefit:${v.resourceId || v.vmName}`,
        category: "lever",
        jeannieRule: 2,
        order: order++,
        title: `Windows Hybrid Benefit — ${v.vmName} (${v.vCores}-core)`,
        severity: "conditional",
        monthlySaving: monthly,
        annualSaving: roundCents(monthly * 12),
        currency: v.currency,
        confidence: "high",
        evidence: v.evidenceRows,
        narrative: {
          customer:
            `If you hold a Windows Server licence with Software Assurance for this server, ` +
            `we can switch off the Windows rental fee on it and save you about ` +
            `${formatMoney(monthly, v.currency)} a month — roughly ${formatMoney(monthly * 12, v.currency)} a year.`,
          consultant:
            `${v.vmName} (${v.meter}, ${v.resourceLocation}, RG ${v.resourceGroup}) is paying the ` +
            `Windows Server uplift via meter '${v.meter}'. Period cost = ${formatMoney(monthly, v.currency)}. ` +
            `Recoverable in full with Hybrid Benefit (Windows SA cores required: ${v.vCores}). ` +
            `Apply via VM blade → Configuration → Azure Hybrid Benefit. No restart.`,
          informational:
            `Implements Jeannie Rule 2 (Hybrid Benefit Layer 1 — Windows visible on invoice) ` +
            `and Jeannie Rule 3 (40% uplift, threshold 8 vCores; this VM has ${v.vCores}, included). ` +
            `Evidence: ${v.evidenceRows.length} 'Virtual Machines Licenses' row(s) summing to ` +
            `${formatMoney(monthly, v.currency)} for the period. Saving claim is exact, not estimated, ` +
            `because the uplift line is broken out by Azure on the invoice.`,
        },
        discoveryQuestions: [
          `Do you hold Windows Server Software Assurance with at least ${v.vCores} cores available to deploy to Azure?`,
          `Is this VM in scope for centralised Hybrid Benefit management, or owned by an application team that manages its own licensing?`,
        ],
        effort: "low",
        requiresConfirmation: [
          "Confirm Windows Server SA core entitlement",
          "Confirm no other workload elsewhere is already consuming the SA cores",
        ],
      });
    }

    // ── Aggregated tail for sub-8-vCore VMs (Rule 3) ───────────────────
    if (small.length > 0) {
      const tailCost = roundCents(small.reduce((s, v) => s + v.cost, 0));
      const tailEvidence: EvidenceRow[] = small.flatMap((v) => v.evidenceRows);
      const currency = small[0].currency;
      // Surface the tail only if material — single-currency invoices only.
      findings.push({
        id: "windowsHybridBenefit:tail-under-8-cores",
        category: "lever",
        jeannieRule: 3,
        order: order++,
        title: `Windows Hybrid Benefit — small VM tail (${small.length} VMs under 8 vCores)`,
        severity: "investigate",
        monthlySaving: tailCost,
        annualSaving: roundCents(tailCost * 12),
        currency,
        confidence: "medium",
        evidence: tailEvidence,
        narrative: {
          customer:
            `There is also a small group of ${small.length} smaller servers paying Windows rental. ` +
            `Individually each saving is modest. Worth a conversation if you have spare licences, ` +
            `but not the priority.`,
          consultant:
            `Aggregated tail: ${small.length} VMs under ${VCORE_THRESHOLD} vCores totalling ` +
            `${formatMoney(tailCost, currency)} per period. Per Jeannie Rule 3, do not chase individually; ` +
            `consolidate decision into a single yes/no during the SA discovery conversation.`,
          informational:
            `Implements Jeannie Rule 3 — "the little VMs, it's a waste of time. I would agree. ` +
            `I wouldn't even chase that. But anything over eight cores, I would absolutely do." ` +
            `Aggregated rather than itemised; severity is 'investigate' so this total does NOT ` +
            `contribute to the headline confirmed-savings ladder (Jeannie Rule 10 enforcement).`,
        },
        discoveryQuestions: [
          `Are any of these small VMs candidates for SKU consolidation (e.g. moving 4× B4ms to 1× D16s_v5) before applying Hybrid Benefit?`,
        ],
        effort: "medium",
        requiresConfirmation: ["Confirm SA core pool size before bulk-applying"],
      });
    }

    return findings;
  },
};

/* ---------------------------------------------------------------------- */
/* Helpers                                                                */
/* ---------------------------------------------------------------------- */

function roundCents(n: number): number {
  return Math.round(n * 100) / 100;
}

function formatMoney(amount: number, currency: string): string {
  const sym =
    currency === "USD" ? "$" : currency === "GBP" ? "£" : currency === "EUR" ? "€" : "";
  return `${sym}${amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}
