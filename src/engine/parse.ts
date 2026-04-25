/**
 * XLSX / CSV → ParsedInvoice.
 *
 * The Azure Cost analysis export has a very specific shape:
 *   - 'Summary' sheet with metadata (customer name, scope, start/end date)
 *   - 'Data' sheet with one row per resource × meter × day-aggregate
 *
 * Header names drift — Microsoft is migrating Cost Management exports
 * toward the FOCUS spec (BilledCost, EffectiveCost, etc.), and the portal
 * vs. exports-to-storage paths already use slightly different headers.
 * We accept any known alias for each required column (see COLUMN_ALIASES)
 * and project onto a single canonical name before any rule runs.
 *
 * Header drift is the ONLY leniency. We are still rigid about values:
 * a missing or unrecognised header concept fails the parse. "Lenient on
 * values" would silently normalise away the very anomalies the FinOps
 * engine is supposed to surface.
 *
 * `any` is allowed only at the SheetJS boundary (per code-style rules in
 * prompt.md) and is contained inside `coerceRow`.
 */

import * as XLSX from "xlsx";
import type {
  Currency,
  InvoicePeriod,
  InvoiceRow,
  Money,
  ParsedInvoice,
} from "../types";

/**
 * Canonical column name → accepted header aliases (in preference order,
 * case-insensitive). Add new aliases here when a future export schema
 * appears; do NOT reach into rules to handle drift.
 */
const COLUMN_ALIASES = {
  ResourceId:        ["ResourceId", "InstanceId", "x_ResourceId"],
  ResourceType:      ["ResourceType", "ConsumedService", "x_ResourceType"],
  ResourceLocation:  ["ResourceLocation", "Region", "RegionId", "RegionName"],
  ResourceGroupName: ["ResourceGroupName", "ResourceGroup", "x_ResourceGroupName"],
  SubscriptionName:  ["SubscriptionName", "SubAccountName", "InvoiceSectionName"],
  ServiceName:       ["ServiceName", "ServiceCategory", "MeterCategory", "ServiceFamily"],
  Meter:             ["Meter", "MeterName", "MeterSubCategory", "x_SkuMeterName", "SkuDescription"],
  Tags:              ["Tags", "tags", "x_ResourceTags", "ResourceTags"],
  CostUSD:           ["CostUSD", "BilledCostUSD", "EffectiveCostUSD", "PreTaxCostUSD"],
  Cost:              ["Cost", "BilledCost", "EffectiveCost", "PreTaxCost"],
  Currency:          ["Currency", "BillingCurrency", "BillingCurrencyCode", "PricingCurrency"],
} as const satisfies Record<string, readonly string[]>;

type Canonical = keyof typeof COLUMN_ALIASES;
/** canonical → actual header name present in this file */
type ColumnMap = Record<Canonical, string>;

export interface ParseOptions {
  /** Defaults to the customer name from the Summary sheet. */
  customerNameOverride?: string;
  /**
   * Force a display currency. By default we pick the most common non-USD
   * currency in the rows, falling back to USD.
   */
  displayCurrencyOverride?: Currency;
}

export function parseInvoice(
  fileBuffer: ArrayBuffer | Uint8Array | Buffer,
  sourceFile: string,
  options: ParseOptions = {}
): ParsedInvoice {
  const wb = XLSX.read(fileBuffer, { type: "array", cellDates: true });

  const customerName = options.customerNameOverride
    ?? readCustomerNameFromSummary(wb)
    ?? deriveCustomerNameFromFilename(sourceFile);

  const period = readPeriodFromSummary(wb);

  const dataSheet = wb.Sheets["Data"] ?? wb.Sheets[wb.SheetNames[0]];
  if (!dataSheet) {
    throw new Error(
      `Invoice ${sourceFile}: no 'Data' sheet found. Got sheets: ${wb.SheetNames.join(", ")}.`
    );
  }

  const rawRows: unknown[] = XLSX.utils.sheet_to_json(dataSheet, {
    defval: "",
    raw: true,
  });
  if (rawRows.length === 0) {
    throw new Error(`Invoice ${sourceFile}: 'Data' sheet has no rows.`);
  }
  const columnMap = resolveColumns(rawRows[0], sourceFile);

  const rows = rawRows
    .map((raw) => coerceRow(raw, columnMap))
    .filter((r) => r.serviceName !== "");

  const displayCurrency =
    options.displayCurrencyOverride ?? detectDisplayCurrency(rows);

  const totalCost: Money = {
    amount: rows.reduce((s, r) => s + r.cost, 0),
    currency: displayCurrency,
  };
  const totalCostUsd: Money = {
    amount: rows.reduce((s, r) => s + r.costUsd, 0),
    currency: "USD",
  };

  return {
    customerName,
    period,
    displayCurrency,
    rows,
    totalCost,
    totalCostUsd,
    sourceFile,
  };
}

/* ---------------------------------------------------------------------- */
/* Row coercion                                                           */
/* ---------------------------------------------------------------------- */

function coerceRow(raw: unknown, cols: ColumnMap): InvoiceRow {
  // The only place we tolerate `any` — SheetJS hands back a heterogeneous
  // record. We project it into our strict InvoiceRow immediately.
  const r = raw as Record<string, any>;
  return {
    resourceId: String(r[cols.ResourceId] ?? ""),
    resourceType: String(r[cols.ResourceType] ?? "").toLowerCase(),
    resourceLocation: String(r[cols.ResourceLocation] ?? ""),
    resourceGroupName: String(r[cols.ResourceGroupName] ?? ""),
    subscriptionName: String(r[cols.SubscriptionName] ?? ""),
    serviceName: String(r[cols.ServiceName] ?? ""),
    meter: String(r[cols.Meter] ?? ""),
    tags: String(r[cols.Tags] ?? ""),
    costUsd: toNumber(r[cols.CostUSD]),
    cost: toNumber(r[cols.Cost]),
    currency: String(r[cols.Currency] ?? "USD") as Currency,
  };
}

function toNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (!Number.isNaN(n)) return n;
  }
  return 0;
}

/**
 * Match every canonical column to whichever alias the file actually
 * uses. Throws if a required concept is missing — a malformed export
 * should fail loudly, never silently.
 */
function resolveColumns(firstRow: unknown, sourceFile: string): ColumnMap {
  const headers = Object.keys(firstRow as Record<string, unknown>);
  const byLower = new Map(headers.map((h) => [h.toLowerCase(), h]));

  const map: Partial<ColumnMap> = {};
  const missing: string[] = [];
  for (const canonical of Object.keys(COLUMN_ALIASES) as Canonical[]) {
    const matched = COLUMN_ALIASES[canonical].find(
      (alias) => byLower.has(alias.toLowerCase())
    );
    if (matched) {
      map[canonical] = byLower.get(matched.toLowerCase())!;
    } else {
      missing.push(
        `${canonical} (tried: ${COLUMN_ALIASES[canonical].join(", ")})`
      );
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `Invoice ${sourceFile}: missing required column(s): ${missing.join("; ")}. ` +
      `Got headers: ${headers.join(", ")}.`
    );
  }
  return map as ColumnMap;
}

/* ---------------------------------------------------------------------- */
/* Summary sheet readers                                                  */
/* ---------------------------------------------------------------------- */

function readCustomerNameFromSummary(wb: XLSX.WorkBook): string | null {
  const summary = wb.Sheets["Summary"];
  if (!summary) return null;
  const rows: any[][] = XLSX.utils.sheet_to_json(summary, { header: 1, defval: null });
  for (const row of rows) {
    // Layout from NMEF sample: ['', 'Name:', 'North Mill Equipment Finance LLC', null]
    if (row && String(row[1] ?? "").trim() === "Name:" && row[2]) {
      return String(row[2]).trim();
    }
  }
  return null;
}

/**
 * Reads start/end date from the Summary sheet. Falls back to month-of-file
 * heuristic if absent — but logs nothing; the caller can override via
 * options if it matters.
 */
function readPeriodFromSummary(wb: XLSX.WorkBook): InvoicePeriod {
  const summary = wb.Sheets["Summary"];
  let startDate = "";
  let endDate = "";
  if (summary) {
    const rows: any[][] = XLSX.utils.sheet_to_json(summary, { header: 1, defval: null });
    for (const row of rows) {
      const label = String(row?.[1] ?? "").trim();
      const value = row?.[2];
      if (label === "Start date:" && value) startDate = parseDateLike(value);
      if (label === "End date:" && value) endDate = parseDateLike(value);
    }
  }
  if (!startDate || !endDate) {
    // Defensive default — current month — but Azure exports always carry
    // these fields, so hitting this path likely means a malformed file.
    const now = new Date();
    startDate = startDate || isoDate(new Date(now.getFullYear(), now.getMonth(), 1));
    endDate = endDate || isoDate(new Date(now.getFullYear(), now.getMonth() + 1, 0));
  }
  return {
    startDate,
    endDate,
    hoursInPeriod: computeHoursInPeriod(startDate, endDate),
  };
}

function parseDateLike(v: unknown): string {
  if (v instanceof Date) return isoDate(v);
  const s = String(v).trim();
  // Azure summary format: 'Thu, Jan 01, 2026'
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return isoDate(d);
  return "";
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function computeHoursInPeriod(startIso: string, endIso: string): number {
  const start = new Date(startIso + "T00:00:00Z").getTime();
  const end = new Date(endIso + "T23:59:59Z").getTime();
  return Math.round((end - start) / 3_600_000);
}

/* ---------------------------------------------------------------------- */
/* Misc                                                                   */
/* ---------------------------------------------------------------------- */

function detectDisplayCurrency(rows: InvoiceRow[]): Currency {
  const counts = new Map<Currency, number>();
  for (const r of rows) {
    if (!r.currency) continue;
    counts.set(r.currency, (counts.get(r.currency) ?? 0) + 1);
  }
  // Prefer non-USD if present (the Cost column is local; CostUSD is the
  // crosswalk). Fall back to USD.
  let best: Currency = "USD";
  let bestCount = 0;
  for (const [cur, n] of counts) {
    if (cur !== "USD" && n > bestCount) {
      best = cur;
      bestCount = n;
    }
  }
  return bestCount > 0 ? best : "USD";
}

function deriveCustomerNameFromFilename(sourceFile: string): string {
  // Strip path and extension, take the leading word(s) before 'Azure' or '_'
  const base = sourceFile.split(/[\\/]/).pop() ?? sourceFile;
  const stem = base.replace(/\.[^.]+$/, "");
  const cut = stem.split(/azure|_/i)[0]?.trim();
  return cut && cut.length > 0 ? cut : stem;
}
