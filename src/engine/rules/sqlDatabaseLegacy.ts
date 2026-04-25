/**
 * Rule: legacy SQL database leftovers (Jeannie Rule 9 — humanity layer
 * still applies; Rule 10 — confirmed severity).
 *
 * Detects SQL database resources whose names match known stale-resource
 * patterns: `_old`, `_copy`, `_bak`, `_backup`, `_archive`, `_test_`, or
 * a timestamp suffix `_YYYY-MM-DDtHH-MMz`.
 *
 * Why severity is `confirmed`
 * ---------------------------
 * The cost is demonstrable from the invoice line — it is real money being
 * spent right now. The action (delete) is a known operational pattern.
 * Per Jeannie Rule 10, this means the saving CAN be aggregated into the
 * "immediate wins" scenario.
 *
 * Why effort is `medium`, not `low`
 * ----------------------------------
 * Even a `_old` database may be a deliberate keep-this-for-7-days backup.
 * The engine does NOT auto-recommend deletion without a 48-hour
 * confirmation window question (Jeannie Rule 9). That bumps effort to
 * medium, which means discovery questions are mandatory per the validator.
 */

import type { Finding, ParsedInvoice, Rule, EvidenceRow, InvoiceRow } from "../../types";

const STALE_NAME_PATTERNS: RegExp[] = [
  /_old(\b|_)/i,
  /_copy(\b|_)/i,
  /_bak(\b|_)/i,
  /_backup(\b|_)/i,
  /_archive(\b|_)/i,
  /_test_/i,
  /_\d{4}-\d{2}-\d{2}t\d{2}-\d{2}z/i,
];

function isLegacySqlRow(r: InvoiceRow): boolean {
  if (!/sql/i.test(r.serviceName) && !/sql/i.test(r.resourceType)) return false;
  // Must be a database-level resource (not a server-level meter).
  if (!/databases\//i.test(r.resourceId)) return false;
  return STALE_NAME_PATTERNS.some((p) => p.test(r.resourceId));
}

function dbNameFromResourceId(rid: string): string {
  const parts = rid.split("/");
  return parts[parts.length - 1] ?? rid;
}

export const sqlDatabaseLegacyRule: Rule = {
  id: "sqlDatabaseLegacy",
  name: "Legacy SQL database leftovers (delete candidates)",
  framework: {
    rule: 10,
    quote:
      "Confirmed severity — saving is demonstrable from the invoice alone. Aggregable into immediate wins.",
  },

  evaluate(invoice: ParsedInvoice): Finding[] | null {
    const matches = invoice.rows.filter(isLegacySqlRow);
    if (matches.length === 0) return null;

    // Group by database (resourceId) so multiple meter rows on the same
    // DB collapse into a single finding line.
    const byDb = new Map<string, { rows: InvoiceRow[]; cost: number; currency: string }>();
    for (const r of matches) {
      const agg = byDb.get(r.resourceId) ?? { rows: [], cost: 0, currency: r.currency };
      agg.rows.push(r);
      agg.cost += r.cost;
      byDb.set(r.resourceId, agg);
    }

    const findings: Finding[] = [];
    let order = 1;

    for (const [resourceId, agg] of byDb) {
      const monthly = round2(agg.cost);
      if (monthly <= 0) continue; // Don't flag $0 lines as deletable savings.
      const evidence: EvidenceRow[] = agg.rows.map((r) => ({
        resourceId: r.resourceId,
        meter: r.meter,
        cost: r.cost,
        reason: `Legacy-named SQL database row (matched stale-name pattern).`,
      }));

      findings.push({
        id: `sqlDatabaseLegacy:${resourceId}`,
        category: "anomaly",
        jeannieRule: 10,
        order: order++,
        title: `Delete candidate — ${dbNameFromResourceId(resourceId)}`,
        severity: "confirmed",
        monthlySaving: monthly,
        annualSaving: round2(monthly * 12),
        currency: agg.currency,
        confidence: "high",
        evidence,
        narrative: {
          customer:
            `A SQL database named like a leftover (${dbNameFromResourceId(resourceId)}) is still ` +
            `running and costing about ${formatMoney(monthly, agg.currency)} a month. If it is ` +
            `genuinely a backup or archive, fine. If it is a leftover from a project, deleting it ` +
            `recovers the cost immediately.`,
          consultant:
            `Database '${dbNameFromResourceId(resourceId)}' matches a stale-name pattern. ` +
            `Period cost: ${formatMoney(monthly, agg.currency)}. Recommend 48-hour confirmation window ` +
            `with the application owner, then delete. Action is reversible only via point-in-time-restore ` +
            `if backups are retained — confirm retention policy before deletion.`,
          informational:
            `Implements Jeannie Rule 10 — confirmed severity, saving demonstrable from the invoice. ` +
            `Pattern matched: one of [_old, _copy, _bak, _backup, _archive, _test_, timestamp-suffix]. ` +
            `Effort is 'medium' (not 'low') because deletion is irreversible past the backup window — ` +
            `which makes Jeannie Rule 9 (mandatory discovery question) apply.`,
        },
        discoveryQuestions: [
          `Is '${dbNameFromResourceId(resourceId)}' a deliberate backup/archive, or a leftover that can be deleted?`,
          `If deletion is approved, is the application's point-in-time-restore retention sufficient as a fallback?`,
        ],
        effort: "medium",
        requiresConfirmation: [
          "48-hour deletion confirmation window with application owner",
          "Verify backup retention policy before issuing DROP",
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
