/**
 * Rule: reservation scope / SSD-variant / generation crawl-failure check.
 * Implements Jeannie Rule 4 — "I am a D2 v2 East. I must find one. ... it
 * will crawl and crawl and crawl" (transcript 193–197).
 *
 * Detection
 * ---------
 * We surface the *symptom* a customer can see from billing: a VM family +
 * region pair where there is BOTH an active reservation AND non-zero PAYG
 * compute on the same family. The PAYG is overflow — a sign the reservation
 * isn't crawling onto everything it could.
 *
 * Common causes (called out in the narrative so the customer knows what to
 * check, even though we can't prove which one applies from billing alone):
 *   - Reservation scoped to a single RG when Shared scope would crawl across
 *     the subscription family.
 *   - SSD/spinning-disk variant mismatch (D2V2 vs D2sV2 are separate
 *     reservation namespaces).
 *   - Wrong SKU sub-variant (Linux vs Windows reservation).
 *
 * Severity
 * --------
 * `investigate` — we cannot prove the cause from cost alone (Jeannie Rule 10).
 */

import type { Finding, ParsedInvoice, Rule, EvidenceRow, InvoiceRow } from "../../types";
import { lookupHourlyRate, normaliseSkuToken } from "../rates";
import { round2, formatMoney, nameFromResourceId } from "./_helpers";
import { getFrameworkRule } from "../framework";

function isReservationRow(r: InvoiceRow): boolean {
  return /reservation/i.test(r.meter) || /reservation/i.test(r.serviceName);
}

function familyKey(meter: string): string {
  // 'D4s v5' → 'd_v5', 'B4ms' → 'b_', 'E16 v3' → 'e_v3'
  const tok = normaliseSkuToken(meter);
  const m = tok.match(/^([a-z])(?:\d+[a-z]*)?(?:_(v\d+))?/);
  if (!m) return tok;
  return `${m[1]}_${m[2] ?? ""}`;
}

export const reservationScopeCheckRule: Rule = {
  id: "reservationScopeCheck",
  name: "Reservation scope / variant crawl-failure check",
  framework: { rule: 4, quote: getFrameworkRule(4).statement },

  evaluate(invoice: ParsedInvoice): Finding[] | null {
    // Index PAYG VM rows and reservation rows by (family, region).
    type Bucket = {
      paygCost: number;
      paygRows: InvoiceRow[];
      hasReservation: boolean;
      reservationRows: InvoiceRow[];
      family: string;
      region: string;
    };
    const buckets = new Map<string, Bucket>();

    for (const r of invoice.rows) {
      if (r.serviceName !== "Virtual Machines") continue;
      const fam = familyKey(r.meter);
      const region = r.resourceLocation || "(unspecified)";
      const key = `${fam}|${region}`;
      const b = buckets.get(key) ?? {
        paygCost: 0,
        paygRows: [],
        hasReservation: false,
        reservationRows: [],
        family: fam,
        region,
      };
      if (isReservationRow(r)) {
        b.hasReservation = true;
        b.reservationRows.push(r);
      } else {
        b.paygCost += r.cost;
        b.paygRows.push(r);
      }
      buckets.set(key, b);
    }

    const overflow = [...buckets.values()].filter(
      (b) => b.hasReservation && b.paygCost > 0
    );
    if (overflow.length === 0) return null;

    const findings: Finding[] = [];
    let order = 1;
    for (const b of overflow) {
      const evidence: EvidenceRow[] = b.paygRows.slice(0, 25).map((r) => ({
        resourceId: r.resourceId,
        meter: r.meter,
        cost: round2(r.cost),
        reason: `PAYG compute on family ${b.family} despite reservation present in ${b.region}.`,
      }));
      const monthly = round2(b.paygCost);
      findings.push({
        id: `reservationScopeCheck:${b.family}:${b.region}`,
        category: "lever",
        jeannieRule: 4,
        order: order++,
        title: `Reservation overflow — family ${b.family.toUpperCase()} in ${b.region} (${b.paygRows.length} VMs, ${formatMoney(monthly, invoice.displayCurrency)} PAYG)`,
        severity: "investigate",
        monthlySaving: null,
        annualSaving: null,
        currency: invoice.displayCurrency,
        confidence: "medium",
        evidence,
        narrative: {
          customer:
            `You hold a reservation for the ${b.family.toUpperCase()} family in ${b.region}, but ` +
            `${b.paygRows.length} servers in that family are still being charged at the full pay-as-you-go rate ` +
            `(${formatMoney(monthly, invoice.displayCurrency)} this period). One of three things is usually wrong: ` +
            `the reservation is scoped to one resource group when it could be shared across subscriptions, ` +
            `or it's the wrong disk variant (e.g. D2V2 vs D2sV2), or the count is too low.`,
          consultant:
            `Family/region bucket ${b.family}/${b.region}: reservation present, ${b.paygRows.length} PAYG VMs, ` +
            `${formatMoney(monthly, invoice.displayCurrency)} overflow. Three crawl-failure causes per Jeannie Rule 4: ` +
            `(a) RG-scoped vs Shared scope; (b) SSD vs spinning-disk variant (D2V2 ≠ D2sV2); (c) reservation ` +
            `count below fleet size. Validate via Cost Management → Reservations → Utilisation, then resize or ` +
            `re-scope the reservation.`,
          informational:
            `Detection: same family+region has both reservation rows AND non-zero PAYG. Cannot disambiguate ` +
            `between cause (a)/(b)/(c) from billing alone — severity stays 'investigate' (Jeannie Rule 10). ` +
            `Action is one Azure portal trip; saving is the overflow figure if cause is fixable.`,
        },
        discoveryQuestions: [
          `Is the reservation for ${b.family.toUpperCase()}/${b.region} scoped to a single RG, or Shared?`,
          `Are the overflow VMs on the SSD variant (e.g. D2sV2) while the reservation covers the spinning-disk variant (D2V2), or vice versa?`,
          `Is the reservation count short of the fleet size, or could the fleet shrink to fit?`,
        ],
        effort: "low",
        requiresConfirmation: ["Confirm reservation scope", "Confirm storage variant alignment"],
      });
    }
    return findings;
  },
};
