/**
 * Landscape cards — descriptive context layer that runs alongside the
 * Finding-emitting rules. Logic ported from microsoft/finops-toolkit
 * KQL catalog (src/queries/catalog/) plus governance extensions specific
 * to the Cost Management portal export shape.
 *
 * Each card is pure: ParsedInvoice → LandscapeCard. Add a card by:
 *   1. Adding a builder below.
 *   2. Pushing it into ALL_CARDS.
 *   3. Adding a test in src/test/landscape.test.ts.
 */

import type { InvoiceRow, LandscapeCard, ParsedInvoice } from "../../types";

const TOP_N = 10;
const PARETO_HEAD_PCT = 0.20;
const ORPHAN_REGIONS = new Set(["unassigned", "unknown", "global", ""]);

type CardBuilder = (invoice: ParsedInvoice) => LandscapeCard;

/* ---------------------------------------------------------------------- */
/* Helpers                                                                */
/* ---------------------------------------------------------------------- */

function sumBy<K extends string>(
  rows: readonly InvoiceRow[],
  keyFn: (r: InvoiceRow) => K,
  pickCost: (r: InvoiceRow) => number = (r) => r.cost
): Map<K, number> {
  const m = new Map<K, number>();
  for (const r of rows) {
    const k = keyFn(r);
    m.set(k, (m.get(k) ?? 0) + pickCost(r));
  }
  return m;
}

function topN<K extends string>(
  m: Map<K, number>,
  n: number
): Array<{ key: K; cost: number }> {
  return [...m.entries()]
    .map(([key, cost]) => ({ key, cost }))
    .sort((a, b) => b.cost - a.cost)
    .slice(0, n);
}

function fmtMoney(n: number, currency: string): string {
  return `${currency} ${n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function fmtPct(share: number): string {
  return `${(share * 100).toFixed(1)}%`;
}

/* ---------------------------------------------------------------------- */
/* Cards (KQL ports)                                                      */
/* ---------------------------------------------------------------------- */

/** Port of top-services-by-cost.kql */
export const topServicesCard: CardBuilder = (inv) => {
  const total = inv.rows.reduce((s, r) => s + r.cost, 0);
  const top = topN(sumBy(inv.rows, (r) => r.serviceName || "(unspecified)"), TOP_N);
  return {
    id: "landscape:top-services",
    title: "Top services by cost",
    headline: top[0]
      ? `${top[0].key} leads at ${fmtMoney(top[0].cost, inv.displayCurrency)} (${fmtPct(top[0].cost / total)})`
      : "No service spend",
    columns: ["Service", "Cost", "Share"],
    rows: top.map((t) => ({
      Service: t.key,
      Cost: fmtMoney(t.cost, inv.displayCurrency),
      Share: fmtPct(t.cost / total),
    })),
  };
};

/** Port of top-resource-groups-by-cost.kql */
export const topResourceGroupsCard: CardBuilder = (inv) => {
  const total = inv.rows.reduce((s, r) => s + r.cost, 0);
  const top = topN(
    sumBy(inv.rows, (r) =>
      `${r.subscriptionName || "(no sub)"} / ${r.resourceGroupName || "(no rg)"}`
    ),
    TOP_N
  );
  return {
    id: "landscape:top-resource-groups",
    title: "Top resource groups by cost",
    headline: top[0]
      ? `${top[0].key} = ${fmtMoney(top[0].cost, inv.displayCurrency)} (${fmtPct(top[0].cost / total)})`
      : "No RG spend",
    columns: ["Subscription / RG", "Cost", "Share"],
    rows: top.map((t) => ({
      "Subscription / RG": t.key,
      Cost: fmtMoney(t.cost, inv.displayCurrency),
      Share: fmtPct(t.cost / total),
    })),
  };
};

/** Port of top-resource-types-by-cost.kql */
export const topResourceTypesCard: CardBuilder = (inv) => {
  const total = inv.rows.reduce((s, r) => s + r.cost, 0);
  const top = topN(sumBy(inv.rows, (r) => r.resourceType || "(unspecified)"), TOP_N);
  return {
    id: "landscape:top-resource-types",
    title: "Top resource types by cost",
    headline: top[0]
      ? `${top[0].key} = ${fmtMoney(top[0].cost, inv.displayCurrency)} (${fmtPct(top[0].cost / total)})`
      : "No type spend",
    columns: ["Resource type", "Cost", "Share"],
    rows: top.map((t) => ({
      "Resource type": t.key,
      Cost: fmtMoney(t.cost, inv.displayCurrency),
      Share: fmtPct(t.cost / total),
    })),
  };
};

/** Generic Pareto: % of spend in the most-expensive 20% of resources. */
export const paretoCard: CardBuilder = (inv) => {
  const perResource = sumBy(
    inv.rows.filter((r) => r.resourceId),
    (r) => r.resourceId
  );
  const sorted = [...perResource.values()].filter((v) => v > 0).sort((a, b) => b - a);
  const total = sorted.reduce((s, v) => s + v, 0);
  const headN = Math.max(1, Math.floor(sorted.length * PARETO_HEAD_PCT));
  const headCost = sorted.slice(0, headN).reduce((s, v) => s + v, 0);
  const share = total > 0 ? headCost / total : 0;
  return {
    id: "landscape:pareto",
    title: "Resource-level Pareto (80/20)",
    headline: `Top ${(PARETO_HEAD_PCT * 100).toFixed(0)}% of resources (${headN.toLocaleString()}) = ${fmtPct(share)} of spend`,
    columns: ["Bucket", "Resources", "Cost", "Share"],
    rows: [
      {
        Bucket: `Top ${(PARETO_HEAD_PCT * 100).toFixed(0)}%`,
        Resources: headN,
        Cost: fmtMoney(headCost, inv.displayCurrency),
        Share: fmtPct(share),
      },
      {
        Bucket: "Remainder",
        Resources: sorted.length - headN,
        Cost: fmtMoney(total - headCost, inv.displayCurrency),
        Share: fmtPct(total > 0 ? 1 - share : 0),
      },
    ],
    metrics: {
      resourcesWithSpend: sorted.length,
      headSharePct: Number(fmtPct(share).replace("%", "")),
    },
  };
};

/** Port of cost-by-region-trend.kql, sans trend (no time dimension). */
export const regionDistributionCard: CardBuilder = (inv) => {
  const total = inv.rows.reduce((s, r) => s + r.cost, 0);
  const byRegion = topN(sumBy(inv.rows, (r) => r.resourceLocation || "(unspecified)"), 999);
  const primary = byRegion[0];
  return {
    id: "landscape:region-distribution",
    title: "Region distribution",
    headline: primary
      ? `${primary.key} carries ${fmtPct(primary.cost / total)} of spend`
      : "No region data",
    columns: ["Region", "Cost", "Share"],
    rows: byRegion.map((r) => ({
      Region: r.key,
      Cost: fmtMoney(r.cost, inv.displayCurrency),
      Share: fmtPct(r.cost / total),
    })),
  };
};

/** Custom: orphan / unassigned region cost — likely deleted-resource artefacts. */
export const orphanRegionCard: CardBuilder = (inv) => {
  const total = inv.rows.reduce((s, r) => s + r.cost, 0);
  const orphanRows = inv.rows.filter((r) =>
    ORPHAN_REGIONS.has((r.resourceLocation || "").toLowerCase())
  );
  const orphanTotal = orphanRows.reduce((s, r) => s + r.cost, 0);
  const byService = topN(
    sumBy(orphanRows, (r) => `${r.resourceLocation || "(blank)"} · ${r.serviceName || "(unspec)"}`),
    TOP_N
  );
  return {
    id: "landscape:orphan-region",
    title: "Orphan / unassigned region cost",
    headline: `${fmtMoney(orphanTotal, inv.displayCurrency)} (${fmtPct(total > 0 ? orphanTotal / total : 0)}) lacks a region`,
    columns: ["Region · Service", "Cost"],
    rows: byService.map((b) => ({
      "Region · Service": b.key,
      Cost: fmtMoney(b.cost, inv.displayCurrency),
    })),
    metrics: {
      orphanCost: orphanTotal,
      orphanShare: total > 0 ? orphanTotal / total : 0,
    },
  };
};

/** Port of subscription-by-cost analysis (showback). */
export const subscriptionConcentrationCard: CardBuilder = (inv) => {
  const total = inv.rows.reduce((s, r) => s + r.cost, 0);
  const bySub = topN(sumBy(inv.rows, (r) => r.subscriptionName || "(no sub)"), 999);
  return {
    id: "landscape:subscription-concentration",
    title: "Subscription concentration",
    headline: bySub[0]
      ? `${bySub[0].key} = ${fmtPct(bySub[0].cost / total)} of spend`
      : "No subscription data",
    columns: ["Subscription", "Cost", "Share"],
    rows: bySub.map((b) => ({
      Subscription: b.key,
      Cost: fmtMoney(b.cost, inv.displayCurrency),
      Share: fmtPct(b.cost / total),
    })),
  };
};

/** Custom: tag coverage by spend (governance). */
export const tagCoverageCard: CardBuilder = (inv) => {
  const total = inv.rows.reduce((s, r) => s + r.cost, 0);
  const tagged = inv.rows.filter((r) => r.tags && r.tags.trim() !== "");
  const taggedCost = tagged.reduce((s, r) => s + r.cost, 0);
  const share = total > 0 ? taggedCost / total : 0;
  return {
    id: "landscape:tag-coverage",
    title: "Tag coverage (governance)",
    headline: `${fmtPct(share)} of spend has any tag (${fmtMoney(taggedCost, inv.displayCurrency)} of ${fmtMoney(total, inv.displayCurrency)})`,
    columns: ["Bucket", "Cost", "Share"],
    rows: [
      {
        Bucket: "Tagged",
        Cost: fmtMoney(taggedCost, inv.displayCurrency),
        Share: fmtPct(share),
      },
      {
        Bucket: "Untagged",
        Cost: fmtMoney(total - taggedCost, inv.displayCurrency),
        Share: fmtPct(total > 0 ? 1 - share : 0),
      },
    ],
    metrics: { tagCoverageShare: share },
  };
};

/** Sanity card: invoice integrity (zero / negative line counts). */
export const invoiceIntegrityCard: CardBuilder = (inv) => {
  const neg = inv.rows.filter((r) => r.cost < 0).length;
  const zero = inv.rows.filter((r) => r.cost === 0).length;
  const total = inv.rows.length;
  return {
    id: "landscape:invoice-integrity",
    title: "Invoice integrity",
    headline: `${total.toLocaleString()} lines · ${neg.toLocaleString()} negative · ${zero.toLocaleString()} zero`,
    columns: ["Bucket", "Lines"],
    rows: [
      { Bucket: "Negative", Lines: neg },
      { Bucket: "Zero", Lines: zero },
      { Bucket: "Positive", Lines: total - neg - zero },
    ],
    metrics: { negativeLines: neg, zeroLines: zero, totalLines: total },
  };
};

/* ---------------------------------------------------------------------- */
/* Pipeline                                                               */
/* ---------------------------------------------------------------------- */

export const ALL_CARDS: readonly CardBuilder[] = [
  topServicesCard,
  topResourceGroupsCard,
  topResourceTypesCard,
  paretoCard,
  regionDistributionCard,
  orphanRegionCard,
  subscriptionConcentrationCard,
  tagCoverageCard,
  invoiceIntegrityCard,
] as const;

export function buildLandscape(invoice: ParsedInvoice): LandscapeCard[] {
  return ALL_CARDS.map((build) => build(invoice));
}
