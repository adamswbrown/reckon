/**
 * Rule: SQL Server Hybrid Benefit (Layer 2 of two — see Jeannie Rule 2).
 *
 * Why this rule exists
 * --------------------
 * SQL Server PAYG is embedded silently in compute pricing for marketplace
 * SQL VM images. Unlike Windows rental, it is NEVER a separate line on
 * the invoice. Customers cannot "see" what they are paying for SQL just
 * by reading the bill. That invisibility is the whole reason Jeannie
 * Rule 2 puts SQL HB in its own category.
 *
 * Detection
 * ---------
 * We flag a VM as SQL-suspect when:
 *   - resourceType is microsoft.compute/virtualmachines, AND
 *   - the resourceId, RG name, or VM name contains 'sql' (case-insensitive).
 *
 * For each suspect VM we compute the SQL uplift RANGE:
 *   - LOW  = vCores × SQL_UPLIFT_PER_CORE_HOUR_USD.standard × hoursInPeriod
 *   - HIGH = vCores × SQL_UPLIFT_PER_CORE_HOUR_USD.enterprise × hoursInPeriod
 * We never quote a single number. The validator (validateFindings) will
 * reject any sqlHybridBenefit:* finding without a monthlySavingRange — that
 * is the codified form of Jeannie Rule 2.
 *
 * The discovery question that collapses the range:
 *   "Which SQL Server edition is installed — Standard, Web, or Enterprise?"
 *
 * Severity: `conditional`. The action (apply Hybrid Benefit) requires the
 * customer to confirm they hold SQL Server SA cores in matching edition.
 */

import type { Finding, ParsedInvoice, Rule, EvidenceRow } from "../../types";
import { lookupHourlyRate, normaliseSkuToken, SQL_UPLIFT_PER_CORE_HOUR_USD } from "../rates";
import { getFrameworkRule } from "../framework";

interface VmAgg {
  resourceId: string;
  vmName: string;
  meter: string;
  resourceLocation: string;
  resourceGroup: string;
  vCores: number | null;
  computeCost: number;
  currency: string;
  evidenceRows: EvidenceRow[];
}

function looksLikeSqlVm(row: ParsedInvoice["rows"][number]): boolean {
  if (row.resourceType !== "microsoft.compute/virtualmachines") return false;
  const haystack = `${row.resourceId} ${row.resourceGroupName} ${row.meter}`.toLowerCase();
  return /\bsql\b|sqlvm|sqlserver|mssql/.test(haystack);
}

function vCoresFromMeter(meter: string, resourceLocation: string): number | null {
  const lookup = lookupHourlyRate(meter, resourceLocation);
  if (lookup) return lookup.sku.vCores;
  const m = normaliseSkuToken(meter).match(/^[a-z]+(\d+)/);
  return m ? Number(m[1]) : null;
}

export const sqlHybridBenefitRule: Rule = {
  id: "sqlHybridBenefit",
  name: "SQL Server Hybrid Benefit (Layer 2 — invisible on invoice)",
  framework: {
    rule: 2,
    quote: getFrameworkRule(2).statement
      || "Jeannie Rule 2 — SQL HB is the invisible second layer; always quote a range.",
  },

  evaluate(invoice: ParsedInvoice): Finding[] | null {
    const sqlRows = invoice.rows.filter(looksLikeSqlVm);
    if (sqlRows.length === 0) return null;

    const byVm = new Map<string, VmAgg>();
    for (const r of sqlRows) {
      const key = r.resourceId;
      let agg = byVm.get(key);
      if (!agg) {
        agg = {
          resourceId: r.resourceId,
          vmName: r.resourceId.split("/").pop() ?? "(unknown SQL VM)",
          meter: r.meter,
          resourceLocation: r.resourceLocation,
          resourceGroup: r.resourceGroupName,
          vCores: vCoresFromMeter(r.meter, r.resourceLocation),
          computeCost: 0,
          currency: r.currency,
          evidenceRows: [],
        };
        byVm.set(key, agg);
      }
      agg.computeCost += r.cost;
      agg.evidenceRows.push({
        resourceId: r.resourceId,
        meter: r.meter,
        cost: r.cost,
        reason: `SQL VM compute line — uplift estimated, not invoice-visible`,
      });
    }

    const findings: Finding[] = [];
    let order = 1;
    const hoursInPeriod = invoice.period.hoursInPeriod;

    for (const v of byVm.values()) {
      if (!v.vCores) continue; // can't estimate without cores
      const low = round2(v.vCores * SQL_UPLIFT_PER_CORE_HOUR_USD.standard * hoursInPeriod);
      const high = round2(v.vCores * SQL_UPLIFT_PER_CORE_HOUR_USD.enterprise * hoursInPeriod);

      findings.push({
        id: `sqlHybridBenefit:${v.resourceId}`,
        category: "lever",
        jeannieRule: 2,
        order: order++,
        title: `SQL Server Hybrid Benefit — ${v.vmName} (${v.vCores}-core)`,
        severity: "conditional",
        // Range, never a point estimate (Rule 2; enforced by validator)
        monthlySaving: null,
        annualSaving: null,
        monthlySavingRange: [low, high],
        annualSavingRange: [round2(low * 12), round2(high * 12)],
        currency: v.currency,
        confidence: "medium",
        evidence: v.evidenceRows,
        narrative: {
          customer:
            `This server looks like it is running SQL Server. If you hold SQL Server licences ` +
            `with Software Assurance, we can switch off the SQL rental fee that is bundled into ` +
            `the per-hour cost. Saving depends on the edition installed: somewhere between ` +
            `${formatMoney(low, v.currency)} and ${formatMoney(high, v.currency)} per month. ` +
            `One question — Standard or Enterprise edition? — collapses that to a single number.`,
          consultant:
            `${v.vmName} (${v.meter}, ${v.resourceLocation}) flagged as SQL-suspect via name pattern. ` +
            `SQL uplift is not broken out on the invoice (Jeannie Rule 2 — Layer 2 is invisible). ` +
            `Estimated uplift across ${hoursInPeriod}h period at ${v.vCores} cores: ` +
            `Standard floor ${formatMoney(low, v.currency)}, Enterprise ceiling ${formatMoney(high, v.currency)}. ` +
            `Web edition (rare) would be ~$${(v.vCores * SQL_UPLIFT_PER_CORE_HOUR_USD.web * hoursInPeriod).toFixed(2)}. ` +
            `Apply via VM blade → Configuration → AHB for SQL Server. License mobility check required.`,
          informational:
            `Implements Jeannie Rule 2 (Layer 2 — SQL HB invisible on invoice). ` +
            `Uplift is computed from SKU vCores × SQL per-core rate × period hours; the rate ` +
            `table cites Microsoft list prices (Enterprise $${SQL_UPLIFT_PER_CORE_HOUR_USD.enterprise}/core/hr, ` +
            `Standard $${SQL_UPLIFT_PER_CORE_HOUR_USD.standard}/core/hr). The finding is presented as a ` +
            `RANGE because the engine cannot see SQL edition from billing data. The validator ` +
            `(RULE2_SQL_HB_POINT_ESTIMATE) rejects any sqlHybridBenefit finding without a range — ` +
            `if you see this finding rendered as a single number, the validator is broken.`,
        },
        discoveryQuestions: [
          `Which SQL Server edition is installed on ${v.vmName} — Standard, Web, or Enterprise?`,
          `Do you hold SQL Server licences with Software Assurance for matching cores?`,
          `Is this VM running paginated SQL (single instance) or a clustered AG that needs separate licensing?`,
        ],
        effort: "medium",
        requiresConfirmation: [
          "Confirm SQL Server edition installed",
          "Confirm SA core entitlement for matching edition",
          "Confirm the VM image is the marketplace SQL image (not BYOL)",
        ],
      });
    }

    return findings.length > 0 ? findings : null;
  },
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function formatMoney(amount: number, currency: string): string {
  const sym =
    currency === "USD" ? "$" : currency === "GBP" ? "£" : currency === "EUR" ? "€" : "";
  return `${sym}${amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}
