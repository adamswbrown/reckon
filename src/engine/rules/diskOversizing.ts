/**
 * Rule: oversized managed disks (P40+) on AVD/VDI VMs.
 * Implements Jeannie Rule 7 (invoice cannot prove right-size; needs IOPS
 * data) — severity stays `conditional`.
 */

import type { Finding, ParsedInvoice, Rule, EvidenceRow } from "../../types";
import { round2, formatMoney } from "./_helpers";

const AVD_TOKENS = ["avd", "vdi", "sessionhost", "wvd", "desktop"];

export const diskOversizingRule: Rule = {
  id: "diskOversizing",
  name: "Oversized managed disks on AVD pools",
  framework: { rule: 7, quote: "Right-size requires IOPS data; this is the surfacing signal only." },

  evaluate(invoice: ParsedInvoice): Finding[] | null {
    // Look for P40 / P50 / P60 disks (or E40+ for Premium SSD v2 / Standard SSD).
    const big = invoice.rows.filter(
      (r) =>
        r.resourceType === "microsoft.compute/disks" &&
        /\b[PE]([4-7]\d)\b/i.test(r.meter)
    );
    if (big.length === 0) return null;

    // Filter to AVD-named RGs (P40+ on a SQL VM is fine).
    const inAvd = big.filter((r) => {
      const lc = `${r.resourceId} ${r.resourceGroupName}`.toLowerCase();
      return AVD_TOKENS.some((t) => lc.includes(t));
    });
    if (inAvd.length === 0) return null;

    const totalCost = round2(inAvd.reduce((s, r) => s + r.cost, 0));
    const monthlyHigh = round2(totalCost * 0.6); // assume 60% saving moving down two tiers
    const monthlyLow = round2(totalCost * 0.3);

    const evidence: EvidenceRow[] = inAvd.slice(0, 25).map((r) => ({
      resourceId: r.resourceId,
      meter: r.meter,
      cost: round2(r.cost),
      reason: `${r.meter} on AVD-pattern resource — over-provisioned unless IOPS justify it.`,
    }));

    return [{
      id: "diskOversizing",
      category: "anomaly",
      jeannieRule: 7,
      order: 1,
      title: `Oversized AVD disks — ${inAvd.length} P40+ tier disks on session-host RGs`,
      severity: "conditional",
      monthlySaving: null,
      annualSaving: null,
      monthlySavingRange: [monthlyLow, monthlyHigh],
      annualSavingRange: [round2(monthlyLow * 12), round2(monthlyHigh * 12)],
      currency: invoice.displayCurrency,
      confidence: "low",
      evidence,
      narrative: {
        customer:
          `${inAvd.length} large premium disks (P40 tier or larger) are attached to your AVD/desktop pool. ` +
          `Most desktop sessions don't need that level of IOPS. Dropping a tier or two could save ` +
          `${formatMoney(monthlyLow, invoice.displayCurrency)}–${formatMoney(monthlyHigh, invoice.displayCurrency)} ` +
          `per month — but we need to confirm the IOPS first.`,
        consultant:
          `${inAvd.length} P40+ premium disks on AVD-named RGs. Saving range assumes 1–2 tier downgrade. ` +
          `Validate via Storage Insights / Disk IOPS metrics over a 7-day window before resizing — Premium SSD v2 ` +
          `is often a better target than Premium SSD v1 if IOPS profile is bursty.`,
        informational:
          `Detection: microsoft.compute/disks with meter matching /\\b[PE][4-7]\\d\\b/ in AVD-named RGs. ` +
          `Saving is RANGE — Jeannie Rule 7 (cannot prove right-size from cost). Discovery question on IOPS ` +
          `is mandatory per Rule 9.`,
      },
      discoveryQuestions: [
        `Have you measured the actual IOPS / throughput on these disks over a representative week?`,
        `Are any of these disks part of a Premium-SSD-only compliance requirement?`,
      ],
      effort: "high",
      requiresConfirmation: ["IOPS measurement", "Application owner sign-off on tier change"],
    }];
  },
};
