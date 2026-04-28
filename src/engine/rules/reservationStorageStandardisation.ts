/**
 * Rule: same VM family running on both SSD and HDD in one region — recommend
 * standardising on SSD so a single Instance Size Flexibility (family-scope)
 * reservation can cover the whole family. Implements Jeannie Rule 4.
 *
 * Detection
 * ---------
 * Group VM rows (PAYG and reservations) by (family, region) and emit a
 * finding when both storage variants ('s' suffix = premium SSD vs no 's' =
 * spinning disk) are present in the same family + region. Fires
 * independently of whether a reservation is already in place — the point is
 * that the split itself blocks Instance Size Flexibility from covering the
 * full family with one commitment.
 *
 * Severity
 * --------
 * `investigate` — the migration from HDD to SSD touches workload semantics
 * (IOPS, cost, snapshot story) that the invoice cannot speak to.
 */

import type { Finding, ParsedInvoice, Rule, EvidenceRow, InvoiceRow } from "../../types";
import { parseSkuToken, storageVariantLabel } from "../rates";
import { round2, formatMoney } from "./_helpers";
import { getFrameworkRule } from "../framework";

export const reservationStorageStandardisationRule: Rule = {
  id: "reservationStorageStandardisation",
  name: "Standardise on SSD to unlock Instance Size Flexibility",
  framework: { rule: 4, quote: getFrameworkRule(4).statement },

  evaluate(invoice: ParsedInvoice): Finding[] | null {
    type Side = { cost: number; rows: InvoiceRow[] };
    type Bucket = {
      family: string;
      region: string;
      ssd: Side;
      hdd: Side;
    };
    const buckets = new Map<string, Bucket>();

    for (const r of invoice.rows) {
      if (r.serviceName !== "Virtual Machines") continue;
      const parsed = parseSkuToken(r.meter);
      if (parsed.family === "?") continue;
      const region = r.resourceLocation || "(unspecified)";
      const key = `${parsed.family}|${region}`;
      const b = buckets.get(key) ?? {
        family: parsed.family,
        region,
        ssd: { cost: 0, rows: [] },
        hdd: { cost: 0, rows: [] },
      };
      const side = storageVariantLabel(parsed) === "ssd" ? b.ssd : b.hdd;
      side.cost += r.cost;
      side.rows.push(r);
      buckets.set(key, b);
    }

    const split = [...buckets.values()].filter(
      (b) => b.ssd.rows.length > 0 && b.hdd.rows.length > 0
    );
    if (split.length === 0) return null;

    const findings: Finding[] = [];
    let order = 1;
    for (const b of split) {
      const famLabel = b.family.toUpperCase();
      const hddCost = round2(b.hdd.cost);
      const ssdCost = round2(b.ssd.cost);
      const totalCost = round2(b.hdd.cost + b.ssd.cost);
      const evidence: EvidenceRow[] = [
        ...b.hdd.rows.slice(0, 10).map((r) => ({
          resourceId: r.resourceId,
          meter: r.meter,
          cost: round2(r.cost),
          reason: `HDD variant of family ${famLabel} in ${b.region} — blocks Instance Size Flexibility for the SSD reservation pool.`,
        })),
        ...b.ssd.rows.slice(0, 10).map((r) => ({
          resourceId: r.resourceId,
          meter: r.meter,
          cost: round2(r.cost),
          reason: `SSD variant of family ${famLabel} in ${b.region} — would be the consolidation target.`,
        })),
      ];
      findings.push({
        id: `reservationStorageStandardisation:${b.family}:${b.region}`,
        category: "lever",
        jeannieRule: 4,
        order: order++,
        title: `Family ${famLabel} runs on both SSD and HDD in ${b.region} — standardise on SSD to unlock Instance Size Flexibility (${formatMoney(totalCost, invoice.displayCurrency)} in scope)`,
        severity: "investigate",
        monthlySaving: null,
        annualSaving: null,
        currency: invoice.displayCurrency,
        confidence: "medium",
        evidence,
        narrative: {
          customer:
            `The ${famLabel} family in ${b.region} runs on two different disk types: ` +
            `${b.ssd.rows.length} server${b.ssd.rows.length === 1 ? "" : "s"} on the newer SSD variant and ` +
            `${b.hdd.rows.length} on the older one. A reservation can only cover one disk type at a time, so this split forces ` +
            `you to either buy two separate commitments or leave half the family uncovered. ` +
            `If the older servers can be moved to SSD, a single family-wide commitment then covers every size in the family.`,
          consultant:
            `Family ${famLabel}/${b.region} split across SSD (${b.ssd.rows.length} VMs, ${formatMoney(ssdCost, invoice.displayCurrency)}) ` +
            `and HDD (${b.hdd.rows.length} VMs, ${formatMoney(hddCost, invoice.displayCurrency)}). Instance Size Flexibility (family-scope) ` +
            `reservations cannot bridge SSD↔HDD, so the split limits one reservation to one side of the family. Per Jeannie Rule 4, ` +
            `the standing remediation is to migrate the HDD variant to SSD (typically a disk-type change rather than a SKU re-tier) ` +
            `and then place a single family-scope reservation that covers every size in ${famLabel}. Validate IOPS / cost / snapshot ` +
            `posture before migrating.`,
          informational:
            `Detection: same VM family appears in both storage namespaces (s-suffix vs no s-suffix) within one region. ` +
            `Buckets aggregate every VM row (PAYG and reservation). The 's' in the SKU name is Azure's marker for premium-SSD-capable ` +
            `VMs. Saving is not quantified — depends on the per-VM disk migration cost and the post-consolidation reservation profile. ` +
            `Severity stays 'investigate' (Jeannie Rule 10) because the migration touches workload semantics the invoice cannot speak to.`,
        },
        discoveryQuestions: [
          `Can the ${b.hdd.rows.length} HDD-variant VMs in ${famLabel}/${b.region} tolerate a move to premium SSD (IOPS, cost-per-GB, snapshot policy)?`,
          `Are any HDD-variant workloads pinned to spinning disk for a hard reason (compliance, retention cost, throughput profile)?`,
          `If consolidation goes ahead, is a 3-year family-scope reservation in scope (Rule 5: exchange-safe across compute)?`,
        ],
        effort: "medium",
        requiresConfirmation: [
          "Confirm HDD workloads can move to SSD",
          "Confirm reservation scope (Shared vs RG)",
        ],
      });
    }
    return findings;
  },
};
