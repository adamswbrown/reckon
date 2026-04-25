/**
 * Shared helpers used by multiple rule files. Kept in one place so
 * detection conventions (what counts as "non-prod", how money is formatted,
 * how to round) don't drift between rules.
 */

import type { InvoiceRow } from "../../types";

/* ---------------------------------------------------------------------- */
/* Environment / lifecycle classification                                 */
/* ---------------------------------------------------------------------- */

const NONPROD_TOKENS = [
  "-dev-", "_dev_", ".dev.",
  "-test-", "_test_", ".test.",
  "-stage-", "_stage_", ".stage.",
  "-staging-", "_staging_",
  "-uat-", "_uat_",
  "-poc-", "_poc_", ".poc.",
  "-sandbox-", "_sandbox_", "sandbox",
  "-qa-", "_qa_", ".qa.",
  "-preprod-", "_preprod_",
];
const PROD_TOKENS = ["-prod-", "_prod_", ".prod.", "production"];

/**
 * Conservative non-prod heuristic. We require an explicit non-prod marker
 * and the absence of an explicit prod marker. False negatives are fine —
 * we don't want to recommend tier downgrades on something that turns out
 * to be production.
 */
export function isNonProdName(name: string): boolean {
  if (!name) return false;
  const lc = name.toLowerCase();
  if (PROD_TOKENS.some((t) => lc.includes(t))) return false;
  return NONPROD_TOKENS.some((t) => lc.includes(t));
}

/* ---------------------------------------------------------------------- */
/* Money formatting                                                       */
/* ---------------------------------------------------------------------- */

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function formatMoney(amount: number, currency: string): string {
  const sym =
    currency === "USD" ? "$" : currency === "GBP" ? "£" : currency === "EUR" ? "€" : "";
  return `${sym}${amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

/* ---------------------------------------------------------------------- */
/* Resource id helpers                                                    */
/* ---------------------------------------------------------------------- */

export function nameFromResourceId(resourceId: string): string {
  return resourceId.split("/").pop() ?? resourceId;
}

export function pickPredominantCurrency(rows: InvoiceRow[]): string {
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (!r.currency) continue;
    counts.set(r.currency, (counts.get(r.currency) ?? 0) + 1);
  }
  let best = "USD";
  let bestCount = 0;
  for (const [cur, n] of counts) {
    if (n > bestCount) {
      best = cur;
      bestCount = n;
    }
  }
  return best;
}
