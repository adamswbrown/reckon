/**
 * Rule: VM runtime derivation (Jeannie Rule 8 — reverse-engineer hours from cost).
 *
 * Jeannie: "my job was to pull a report like this. Take the number of minutes
 * that they ran total. Yes. Divide by the minutes in the month for max capacity
 * to see how much they're burning it." (transcript line 163)
 *
 * For every VM with non-zero compute cost we compute:
 *   billed_hours = vm_compute_cost / hourly_rate_for_sku_in_region
 * and classify the VM into one of five buckets:
 *   - fully-reserved      — $0 compute AND a matching reservation row exists
 *   - reservation-overflow — non-zero compute AND a reservation also exists
 *   - unreserved-running   — non-zero compute, no reservation; report exact hours
 *   - apparently-dormant   — $0 across all services in the RG, no covering reservation
 *   - unknown-rate         — SKU not in rates.ts (we say so honestly)
 *
 * Output style
 * ------------
 * This rule does NOT recommend an action by itself — it produces an
 * `investigate`-severity finding per VM cluster (grouped by classification)
 * that downstream rules consume. The runtime view is a fact, not a saving.
 *
 * Jeannie Rule 6 reminder ("Nobody's dimming. They're sprawling.") means
 * always-on (744h) is EXPECTED. We render those neutrally; the interesting
 * signals are the part-time, dormant, and overflow buckets.
 */

import type { Finding, ParsedInvoice, Rule, EvidenceRow, InvoiceRow } from "../../types";
import { lookupHourlyRate } from "../rates";
import { getFrameworkRule } from "../framework";

type Classification =
  | "fully-reserved"
  | "reservation-overflow"
  | "unreserved-running"
  | "apparently-dormant"
  | "unknown-rate";

interface VmRuntime {
  resourceId: string;
  vmName: string;
  resourceGroup: string;
  meter: string;
  resourceLocation: string;
  computeCost: number;
  ambientCost: number;       // cost of all non-VM rows in the same RG
  hasReservation: boolean;
  hourlyRate: number | null;
  billedHours: number | null;
  utilisationPct: number | null;
  classification: Classification;
}

/** Heuristic: a 'reservation' row is one whose meter mentions 'Reservation'. */
function isReservationRow(r: InvoiceRow): boolean {
  return /reservation/i.test(r.meter) || /reservation/i.test(r.serviceName);
}

export const vmRuntimeDerivationRule: Rule = {
  id: "vmRuntimeDerivation",
  name: "VM runtime derivation (hours-from-cost)",
  framework: {
    rule: 8,
    quote: getFrameworkRule(8).statement,
  },

  evaluate(invoice: ParsedInvoice): Finding[] | null {
    const hoursInPeriod = invoice.period.hoursInPeriod;

    // Index rows by VM and by RG.
    const vmRows = new Map<string, InvoiceRow[]>(); // keyed by resourceId
    const rgCost = new Map<string, number>();
    const rgVms = new Map<string, Set<string>>();

    for (const r of invoice.rows) {
      if (r.resourceType === "microsoft.compute/virtualmachines") {
        const arr = vmRows.get(r.resourceId) ?? [];
        arr.push(r);
        vmRows.set(r.resourceId, arr);
        const vmsInRg = rgVms.get(r.resourceGroupName) ?? new Set<string>();
        vmsInRg.add(r.resourceId);
        rgVms.set(r.resourceGroupName, vmsInRg);
      }
      if (r.resourceGroupName) {
        rgCost.set(r.resourceGroupName, (rgCost.get(r.resourceGroupName) ?? 0) + r.cost);
      }
    }
    if (vmRows.size === 0) return null;

    const runtimes: VmRuntime[] = [];
    for (const [resourceId, rows] of vmRows) {
      // Pick the canonical compute meter (largest cost compute line, not licenses).
      const computeRows = rows.filter(
        (r) => r.serviceName === "Virtual Machines" && !isReservationRow(r)
      );
      const reservationRows = rows.filter(isReservationRow);
      const computeCost = computeRows.reduce((s, r) => s + r.cost, 0);
      const hasReservation = reservationRows.length > 0;

      const principal = pickPrincipalRow(computeRows) ?? rows[0];
      const meter = principal?.meter ?? "";
      const resourceLocation = principal?.resourceLocation ?? "";
      const lookup = lookupHourlyRate(meter, resourceLocation);

      // Ambient cost = everything in this RG that isn't this VM's own compute.
      const rg = principal?.resourceGroupName ?? "";
      const ambientCost =
        (rgCost.get(rg) ?? 0) - rows.reduce((s, r) => s + r.cost, 0);

      let classification: Classification;
      let billedHours: number | null = null;
      let utilisationPct: number | null = null;

      if (computeCost === 0 && hasReservation) {
        classification = "fully-reserved";
      } else if (computeCost === 0) {
        classification = "apparently-dormant";
      } else if (!lookup) {
        classification = "unknown-rate";
      } else if (hasReservation) {
        classification = "reservation-overflow";
        billedHours = round2(computeCost / lookup.hourlyUsd);
        utilisationPct = round2((billedHours / hoursInPeriod) * 100);
      } else {
        classification = "unreserved-running";
        billedHours = round2(computeCost / lookup.hourlyUsd);
        utilisationPct = round2((billedHours / hoursInPeriod) * 100);
      }

      runtimes.push({
        resourceId,
        vmName: resourceId.split("/").pop() ?? "(unknown VM)",
        resourceGroup: rg,
        meter,
        resourceLocation,
        computeCost,
        ambientCost,
        hasReservation,
        hourlyRate: lookup?.hourlyUsd ?? null,
        billedHours,
        utilisationPct,
        classification,
      });
    }

    // Group into one finding per classification bucket. This keeps the report
    // scannable — the per-VM list lives in the evidence rows.
    const findings: Finding[] = [];
    let order = 1;

    const groups: Record<Classification, VmRuntime[]> = {
      "fully-reserved": [],
      "reservation-overflow": [],
      "unreserved-running": [],
      "apparently-dormant": [],
      "unknown-rate": [],
    };
    for (const v of runtimes) groups[v.classification].push(v);

    const currency = invoice.displayCurrency;

    for (const [klass, vms] of Object.entries(groups) as [Classification, VmRuntime[]][]) {
      if (vms.length === 0) continue;
      const totalCost = round2(vms.reduce((s, v) => s + v.computeCost, 0));
      const evidence: EvidenceRow[] = vms.map((v) => ({
        resourceId: v.resourceId,
        meter: v.meter || "(no compute meter)",
        cost: round2(v.computeCost),
        reason: classificationEvidenceReason(v),
      }));

      findings.push({
        id: `vmRuntimeDerivation:${klass}`,
        category: "runtime",
        jeannieRule: klass === "apparently-dormant" ? 6 : 8,
        order: order++,
        title: classificationTitle(klass, vms.length),
        // Runtime classifier never claims a saving — see header comment.
        // Severity is `investigate` so Rule 10 prevents these from being
        // mistakenly aggregated into the savings ladder.
        severity: "investigate",
        monthlySaving: null,
        annualSaving: null,
        currency,
        confidence: lookup_confidence(klass),
        evidence,
        narrative: classificationNarrative(klass, vms, totalCost, currency, hoursInPeriod),
        discoveryQuestions: classificationDiscoveryQuestions(klass),
        effort: "low",
        requiresConfirmation: [],
      });
    }

    return findings;
  },
};

/* ---------------------------------------------------------------------- */
/* Helpers                                                                */
/* ---------------------------------------------------------------------- */

function pickPrincipalRow(rows: InvoiceRow[]): InvoiceRow | undefined {
  if (rows.length === 0) return undefined;
  return [...rows].sort((a, b) => b.cost - a.cost)[0];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function lookup_confidence(klass: Classification): "high" | "medium" | "low" {
  switch (klass) {
    case "fully-reserved":
    case "unreserved-running":
      return "high";
    case "reservation-overflow":
      return "medium";
    case "apparently-dormant":
    case "unknown-rate":
      return "low";
  }
}

function classificationTitle(klass: Classification, n: number): string {
  switch (klass) {
    case "fully-reserved":      return `Fully reserved VMs (${n})`;
    case "reservation-overflow":return `Reservation overflow — VMs incurring PAYG despite a reservation (${n})`;
    case "unreserved-running":  return `Unreserved running VMs (${n}) — reservation candidates`;
    case "apparently-dormant":  return `Apparently dormant VMs (${n}) — $0 compute, ambient cost only`;
    case "unknown-rate":        return `VMs on SKUs not in the rate table (${n}) — runtime not derivable`;
  }
}

function classificationEvidenceReason(v: VmRuntime): string {
  switch (v.classification) {
    case "fully-reserved":
      return "Compute cost is $0 and a reservation row exists — covered.";
    case "reservation-overflow":
      return `Compute cost ${v.computeCost.toFixed(2)} despite reservation ` +
        `→ ~${v.billedHours}h overflow (${v.utilisationPct}% of period).`;
    case "unreserved-running":
      return `${v.billedHours}h billed at ${v.hourlyRate}/hr (${v.utilisationPct}% of period).`;
    case "apparently-dormant":
      return `Zero compute cost. RG ambient cost = ${v.ambientCost.toFixed(2)} ` +
        `(disks, network, monitoring still running).`;
    case "unknown-rate":
      return `SKU '${v.meter}' (${v.resourceLocation}) not in rates.ts — cannot derive hours.`;
  }
}

function classificationDiscoveryQuestions(klass: Classification): string[] {
  switch (klass) {
    case "fully-reserved":
      return [
        "Are these reservations the right SKU/region for the workloads now, or were they bought for a different fleet?",
      ];
    case "reservation-overflow":
      return [
        "Why is this VM running outside reservation coverage — wrong SKU, wrong region, or insufficient reservation count?",
        "Is the overflow steady-state or a temporary scale event we should ignore?",
      ];
    case "unreserved-running":
      return [
        "Will this workload still be here in 12 months? (3-year RI is fine even if not — see Jeannie Rule 5: exchange dollar-for-dollar.)",
        "Is the VM expected to run 24/7, or could it be schedulable?",
      ];
    case "apparently-dormant":
      return [
        "Is this VM stopped-deallocated by design (e.g. DR), or has it been forgotten?",
        "If it is forgotten, what is preventing the disks/IPs/Defender lines from being decommissioned?",
      ];
    case "unknown-rate":
      return [
        "Add this SKU to the rate table OR confirm the VM is a special-purpose family (HBv4, NDv5, etc.) that needs bespoke pricing analysis.",
      ];
  }
}

function classificationNarrative(
  klass: Classification,
  vms: VmRuntime[],
  totalCost: number,
  currency: string,
  hoursInPeriod: number
): { customer: string; consultant: string; informational: string } {
  const sym = currency === "USD" ? "$" : currency === "GBP" ? "£" : "";
  const total = `${sym}${totalCost.toLocaleString()}`;
  const examples = vms.slice(0, 3).map((v) => v.vmName).join(", ");

  switch (klass) {
    case "fully-reserved":
      return {
        customer:
          `${vms.length} VMs are fully covered by your existing reservations — good. ` +
          `Worth checking once a year that the reservation SKUs still match what you actually run.`,
        consultant:
          `${vms.length} VMs reported $0 compute cost and a matching reservation row. ` +
          `Examples: ${examples}. Healthy state. Verify upcoming end dates and exchange windows.`,
        informational:
          `Classification rule: computeCost === 0 AND a reservation row was present. ` +
          `Period analysed: ${hoursInPeriod}h. No saving claim — this is a fact, not a recommendation. ` +
          `Severity is 'investigate' so Rule 10 enforcement excludes this from any aggregated total.`,
      };

    case "reservation-overflow":
      return {
        customer:
          `${vms.length} VMs are partially covered by reservations but still running up an extra ` +
          `${total} on pay-as-you-go. Either we need more reservations of the right kind, or ` +
          `something is in the wrong region/SKU.`,
        consultant:
          `${vms.length} VMs incurring PAYG compute despite reservation rows present. Total overflow: ${total}. ` +
          `Likely causes: wrong scope (RG-bound when Shared would crawl, Jeannie Rule 4), generation drift ` +
          `(v3/v5 mix), or SSD/spinning-disk variant mismatch. Examples: ${examples}.`,
        informational:
          `Implements Jeannie Rule 4 detection surface. Rate lookup uses the largest compute line per VM. ` +
          `billed_hours = compute_cost / hourly_usd. Overflow signals reservation crawl failure ` +
          `that downstream rules (reservationScopeCheck, reservationGenerationConsolidation) act on.`,
      };

    case "unreserved-running":
      return {
        customer:
          `${vms.length} VMs are running on pay-as-you-go and have no reservation. They cost ${total} ` +
          `this period. Most could be moved onto a 3-year reservation for ~30% off — and if the workload ` +
          `goes away, the reservation exchanges into something else dollar-for-dollar (no penalty).`,
        consultant:
          `${vms.length} unreserved running VMs totalling ${total}. ` +
          `Per-VM utilisation derived from cost/rate. Examples: ${examples}. ` +
          `Recommend 3-year RI at ~30% (compute) or 3-year compute Savings Plan if SKU mix is volatile (Jeannie Rule 5).`,
        informational:
          `Classification rule: computeCost > 0 AND no reservation row. billed_hours computed exactly. ` +
          `utilisation% = billed_hours / ${hoursInPeriod}h. ` +
          `This finding seeds the reservation recommendation rules — savings are quantified there, not here.`,
      };

    case "apparently-dormant":
      return {
        customer:
          `${vms.length} VMs appear to have been switched off all month, but their disks, IPs, and ` +
          `monitoring are still running and costing money. Worth a quick check whether they are kept ` +
          `for disaster recovery or just forgotten.`,
        consultant:
          `${vms.length} VMs with $0 compute. Ambient cost remaining (disks, NICs, public IPs, Defender, ` +
          `Log Analytics) is the actual exposure. Examples: ${examples}. Per Jeannie Rule 6 ("they sprawl, ` +
          `they don't dim"), this pattern is the textbook stale-resource signal — escalate to ` +
          `dormantVmCluster rule for RG-level ambient cost analysis.`,
        informational:
          `Implements Jeannie Rule 6 detection. Severity is 'investigate' (not 'confirmed') because ` +
          `a stopped-deallocated DR VM is healthy behaviour and looks identical from cost alone. ` +
          `The discovery question is the gate — Jeannie Rule 9.`,
      };

    case "unknown-rate":
      return {
        customer:
          `${vms.length} VMs are running on specialised SKUs we don't have list prices for in our table. ` +
          `We can dig those out separately if needed.`,
        consultant:
          `${vms.length} VMs on SKUs not in rates.ts. Examples: ${examples}. ` +
          `Either extend rates.ts (preferred) or fall back to live Retail Pricing API lookup. ` +
          `Cost stated honestly: ${total} for the period; runtime hours not derivable without rate.`,
        informational:
          `This bucket exists so the engine never SILENTLY skips a VM. If you see this finding, the rate ` +
          `table needs extending — see tools/fetch-rates.py and the SKU list at the top of rates.ts.`,
      };
  }
}
