/**
 * Azure VM hourly rate lookup — Linux PAYG list prices.
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │  DISCLAIMER — READ BEFORE TRUSTING ANY NUMBER FROM THIS TABLE         │
 * ├──────────────────────────────────────────────────────────────────────┤
 * │  These rates are Linux PAYG RETAIL LIST prices, programmatically      │
 * │  fetched from the Azure Retail Pricing API on RATES_CAPTURED_DATE.    │
 * │  They WILL drift. Microsoft adjusts pricing quarterly.                │
 * │  Customer-specific EA / MCA discounts are NOT reflected — the figures │
 * │  here are list price, not what your customer actually pays.           │
 * │                                                                       │
 * │  USE:    reverse-engineering runtime hours from invoice cost (Jeannie │
 * │          Rule 8) and producing order-of-magnitude saving estimates.   │
 * │  DO NOT: use as a proposal-grade quote.                               │
 * │                                                                       │
 * │  Source query (per region/SKU):                                        │
 * │    GET https://prices.azure.com/api/retail/prices?$filter=             │
 * │      serviceName eq 'Virtual Machines'                                │
 * │      and armRegionName eq '<region>'                                  │
 * │      and armSkuName eq '<skuName>'                                    │
 * │      and priceType eq 'Consumption'                                   │
 * │    Linux PAYG = entry where productName excludes 'Windows'            │
 * │    and skuName excludes 'Spot' / 'Low Priority'.                      │
 * │                                                                       │
 * │  TODO(v2): make this fetch live at app start, cache 24h to disk, and  │
 * │  surface cache age in the Informational report. Until then, refresh   │
 * │  this table quarterly via tools/fetch-rates.py.                       │
 * └──────────────────────────────────────────────────────────────────────┘
 */

import type { Percent } from "../types";
import { pct } from "../types";

/** Date the rate snapshot below was captured from the Retail Pricing API. */
export const RATES_CAPTURED_DATE = "2026-04-22";
export const RATES_SOURCE =
  "Azure Retail Pricing API (https://prices.azure.com/api/retail/prices) — Linux Consumption tier";

export type Region =
  | "us-east"
  | "us-east-2"
  | "uk-south"
  | "west-europe"
  | "north-europe";

export const ALL_REGIONS: readonly Region[] = [
  "us-east",
  "us-east-2",
  "uk-south",
  "west-europe",
  "north-europe",
];

/**
 * Maps Azure-portal region names AND meter region tokens to our canonical
 * Region keys. Azure is inconsistent — sometimes 'eastus', sometimes
 * 'East US', sometimes 'us-east'. Normalise at the boundary.
 */
const REGION_ALIASES: Record<string, Region> = {
  eastus: "us-east",
  "east us": "us-east",
  "us east": "us-east",
  "us-east": "us-east",
  eastus2: "us-east-2",
  "east us 2": "us-east-2",
  "us-east-2": "us-east-2",
  uksouth: "uk-south",
  "uk south": "uk-south",
  "uk-south": "uk-south",
  westeurope: "west-europe",
  "west europe": "west-europe",
  "west-europe": "west-europe",
  northeurope: "north-europe",
  "north europe": "north-europe",
  "north-europe": "north-europe",
};

export function normaliseRegion(raw: string): Region | null {
  const key = raw.trim().toLowerCase();
  return REGION_ALIASES[key] ?? null;
}

export interface SkuRate {
  /** Canonical SKU id, lowercase, no whitespace, e.g. 'd4s_v5'. */
  sku: string;
  /** Family for reservation grouping logic — 'd', 'e', 'b', 'f', etc. */
  family: string;
  /** Generation: 'v3' | 'v4' | 'v5' | 'v6' | '' (e.g. B-series). */
  generation: string;
  /** vCores. Used for the 8-core threshold in Jeannie Rule 3. */
  vCores: number;
  /** True for s-suffix SKUs (premium SSD capable). Matters for crawl logic. */
  isPremiumStorage: boolean;
  /** Hourly USD list price by region. Linux PAYG. */
  hourlyUsd: Partial<Record<Region, number>>;
}

/**
 * RATE TABLE. Linux PAYG, hourly USD, list price.
 *
 * Coverage: B-series (small/medium), D v3/v4/v5/v6, E v3/v4/v5, F v2.
 * For any SKU not in this table, runtime classification falls back to
 * `unknown-rate` — which the engine surfaces honestly rather than guesses.
 */
/**
 * Verified rates — fetched programmatically from the Azure Retail Pricing API
 * on 2026-04-22. Regenerate via `tools/fetch-rates.py`. Any value here that
 * disagrees with the live API by more than rounding is a stale-table bug.
 */
export const SKU_RATES: readonly SkuRate[] = [
  // ─── B-series (burstable) ───────────────────────────────────────────
  { sku: "b2s",     family: "b", generation: "",   vCores:  2, isPremiumStorage: true , hourlyUsd: { "us-east": 0.0416, "us-east-2": 0.0416, "uk-south": 0.0472, "west-europe": 0.048,  "north-europe": 0.045  } },
  { sku: "b2ms",    family: "b", generation: "",   vCores:  2, isPremiumStorage: true , hourlyUsd: { "us-east": 0.0832, "us-east-2": 0.0832, "uk-south": 0.0944, "west-europe": 0.096,  "north-europe": 0.091  } },
  { sku: "b4ms",    family: "b", generation: "",   vCores:  4, isPremiumStorage: true , hourlyUsd: { "us-east": 0.166,  "us-east-2": 0.166,  "uk-south": 0.189,  "west-europe": 0.192,  "north-europe": 0.182  } },
  { sku: "b8ms",    family: "b", generation: "",   vCores:  8, isPremiumStorage: true , hourlyUsd: { "us-east": 0.333,  "us-east-2": 0.333,  "uk-south": 0.378,  "west-europe": 0.384,  "north-europe": 0.364  } },

  // ─── D v3 ───────────────────────────────────────────────────────────
  { sku: "d2_v3",   family: "d", generation: "v3", vCores:  2, isPremiumStorage: false, hourlyUsd: { "us-east": 0.096,  "us-east-2": 0.096,  "uk-south": 0.116,  "west-europe": 0.12,   "north-europe": 0.107  } },
  { sku: "d4_v3",   family: "d", generation: "v3", vCores:  4, isPremiumStorage: false, hourlyUsd: { "us-east": 0.192,  "us-east-2": 0.192,  "uk-south": 0.232,  "west-europe": 0.24,   "north-europe": 0.214  } },
  { sku: "d8_v3",   family: "d", generation: "v3", vCores:  8, isPremiumStorage: false, hourlyUsd: { "us-east": 0.384,  "us-east-2": 0.384,  "uk-south": 0.464,  "west-europe": 0.48,   "north-europe": 0.428  } },
  { sku: "d16_v3",  family: "d", generation: "v3", vCores: 16, isPremiumStorage: false, hourlyUsd: { "us-east": 0.768,  "us-east-2": 0.768,  "uk-south": 0.928,  "west-europe": 0.96,   "north-europe": 0.856  } },

  // ─── D v4 (s-suffix = premium SSD) ──────────────────────────────────
  { sku: "d2s_v4",  family: "d", generation: "v4", vCores:  2, isPremiumStorage: true , hourlyUsd: { "us-east": 0.096,  "us-east-2": 0.096,  "uk-south": 0.111,  "west-europe": 0.115,  "north-europe": 0.107  } },
  { sku: "d4s_v4",  family: "d", generation: "v4", vCores:  4, isPremiumStorage: true , hourlyUsd: { "us-east": 0.192,  "us-east-2": 0.192,  "uk-south": 0.222,  "west-europe": 0.23,   "north-europe": 0.214  } },
  { sku: "d8s_v4",  family: "d", generation: "v4", vCores:  8, isPremiumStorage: true , hourlyUsd: { "us-east": 0.384,  "us-east-2": 0.384,  "uk-south": 0.444,  "west-europe": 0.46,   "north-europe": 0.428  } },
  { sku: "d16s_v4", family: "d", generation: "v4", vCores: 16, isPremiumStorage: true , hourlyUsd: { "us-east": 0.768,  "us-east-2": 0.768,  "uk-south": 0.888,  "west-europe": 0.92,   "north-europe": 0.856  } },

  // ─── D v5 ───────────────────────────────────────────────────────────
  { sku: "d2s_v5",  family: "d", generation: "v5", vCores:  2, isPremiumStorage: true , hourlyUsd: { "us-east": 0.096,  "us-east-2": 0.096,  "uk-south": 0.111,  "west-europe": 0.115,  "north-europe": 0.107  } },
  { sku: "d4s_v5",  family: "d", generation: "v5", vCores:  4, isPremiumStorage: true , hourlyUsd: { "us-east": 0.192,  "us-east-2": 0.192,  "uk-south": 0.222,  "west-europe": 0.23,   "north-europe": 0.214  } },
  { sku: "d8s_v5",  family: "d", generation: "v5", vCores:  8, isPremiumStorage: true , hourlyUsd: { "us-east": 0.384,  "us-east-2": 0.384,  "uk-south": 0.444,  "west-europe": 0.46,   "north-europe": 0.428  } },
  { sku: "d16s_v5", family: "d", generation: "v5", vCores: 16, isPremiumStorage: true , hourlyUsd: { "us-east": 0.768,  "us-east-2": 0.768,  "uk-south": 0.888,  "west-europe": 0.92,   "north-europe": 0.856  } },
  { sku: "d32s_v5", family: "d", generation: "v5", vCores: 32, isPremiumStorage: true , hourlyUsd: { "us-east": 1.536,  "us-east-2": 1.536,  "uk-south": 1.776,  "west-europe": 1.84,   "north-europe": 1.712  } },

  // ─── D v6 (newest as of capture date) ───────────────────────────────
  { sku: "d2s_v6",  family: "d", generation: "v6", vCores:  2, isPremiumStorage: true , hourlyUsd: { "us-east": 0.101,  "us-east-2": 0.101,  "uk-south": 0.117,  "west-europe": 0.121,  "north-europe": 0.112  } },
  { sku: "d4s_v6",  family: "d", generation: "v6", vCores:  4, isPremiumStorage: true , hourlyUsd: { "us-east": 0.202,  "us-east-2": 0.202,  "uk-south": 0.233,  "west-europe": 0.242,  "north-europe": 0.225  } },
  { sku: "d8s_v6",  family: "d", generation: "v6", vCores:  8, isPremiumStorage: true , hourlyUsd: { "us-east": 0.403,  "us-east-2": 0.403,  "uk-south": 0.466,  "west-europe": 0.483,  "north-europe": 0.449  } },
  { sku: "d16s_v6", family: "d", generation: "v6", vCores: 16, isPremiumStorage: true , hourlyUsd: { "us-east": 0.806,  "us-east-2": 0.806,  "uk-south": 0.932,  "west-europe": 0.966,  "north-europe": 0.899  } },

  // ─── E v3 ───────────────────────────────────────────────────────────
  { sku: "e2_v3",   family: "e", generation: "v3", vCores:  2, isPremiumStorage: false, hourlyUsd: { "us-east": 0.126,  "us-east-2": 0.133,  "uk-south": 0.156,  "west-europe": 0.16,   "north-europe": 0.141  } },
  { sku: "e4_v3",   family: "e", generation: "v3", vCores:  4, isPremiumStorage: false, hourlyUsd: { "us-east": 0.252,  "us-east-2": 0.266,  "uk-south": 0.312,  "west-europe": 0.32,   "north-europe": 0.282  } },
  { sku: "e8_v3",   family: "e", generation: "v3", vCores:  8, isPremiumStorage: false, hourlyUsd: { "us-east": 0.504,  "us-east-2": 0.532,  "uk-south": 0.624,  "west-europe": 0.64,   "north-europe": 0.564  } },
  { sku: "e16_v3",  family: "e", generation: "v3", vCores: 16, isPremiumStorage: false, hourlyUsd: { "us-east": 1.008,  "us-east-2": 1.064,  "uk-south": 1.248,  "west-europe": 1.28,   "north-europe": 1.128  } },

  // ─── E v4 ───────────────────────────────────────────────────────────
  { sku: "e2s_v4",  family: "e", generation: "v4", vCores:  2, isPremiumStorage: true , hourlyUsd: { "us-east": 0.126,  "us-east-2": 0.126,  "uk-south": 0.148,  "west-europe": 0.152,  "north-europe": 0.141  } },
  { sku: "e4s_v4",  family: "e", generation: "v4", vCores:  4, isPremiumStorage: true , hourlyUsd: { "us-east": 0.252,  "us-east-2": 0.252,  "uk-south": 0.296,  "west-europe": 0.304,  "north-europe": 0.282  } },
  { sku: "e8s_v4",  family: "e", generation: "v4", vCores:  8, isPremiumStorage: true , hourlyUsd: { "us-east": 0.504,  "us-east-2": 0.504,  "uk-south": 0.592,  "west-europe": 0.608,  "north-europe": 0.564  } },
  { sku: "e16s_v4", family: "e", generation: "v4", vCores: 16, isPremiumStorage: true , hourlyUsd: { "us-east": 1.008,  "us-east-2": 1.008,  "uk-south": 1.184,  "west-europe": 1.216,  "north-europe": 1.128  } },

  // ─── E v5 ───────────────────────────────────────────────────────────
  { sku: "e2s_v5",  family: "e", generation: "v5", vCores:  2, isPremiumStorage: true , hourlyUsd: { "us-east": 0.126,  "us-east-2": 0.126,  "uk-south": 0.148,  "west-europe": 0.152,  "north-europe": 0.141  } },
  { sku: "e4s_v5",  family: "e", generation: "v5", vCores:  4, isPremiumStorage: true , hourlyUsd: { "us-east": 0.252,  "us-east-2": 0.252,  "uk-south": 0.296,  "west-europe": 0.304,  "north-europe": 0.282  } },
  { sku: "e8s_v5",  family: "e", generation: "v5", vCores:  8, isPremiumStorage: true , hourlyUsd: { "us-east": 0.504,  "us-east-2": 0.504,  "uk-south": 0.592,  "west-europe": 0.608,  "north-europe": 0.564  } },
  { sku: "e16s_v5", family: "e", generation: "v5", vCores: 16, isPremiumStorage: true , hourlyUsd: { "us-east": 1.008,  "us-east-2": 1.008,  "uk-south": 1.184,  "west-europe": 1.216,  "north-europe": 1.128  } },
  { sku: "e32s_v5", family: "e", generation: "v5", vCores: 32, isPremiumStorage: true , hourlyUsd: { "us-east": 2.016,  "us-east-2": 2.016,  "uk-south": 2.368,  "west-europe": 2.432,  "north-europe": 2.256  } },

  // ─── F v2 ───────────────────────────────────────────────────────────
  { sku: "f2s_v2",  family: "f", generation: "v2", vCores:  2, isPremiumStorage: true , hourlyUsd: { "us-east": 0.0846, "us-east-2": 0.0846, "uk-south": 0.101,  "west-europe": 0.097,  "north-europe": 0.096  } },
  { sku: "f4s_v2",  family: "f", generation: "v2", vCores:  4, isPremiumStorage: true , hourlyUsd: { "us-east": 0.169,  "us-east-2": 0.169,  "uk-south": 0.202,  "west-europe": 0.194,  "north-europe": 0.192  } },
  { sku: "f8s_v2",  family: "f", generation: "v2", vCores:  8, isPremiumStorage: true , hourlyUsd: { "us-east": 0.338,  "us-east-2": 0.338,  "uk-south": 0.404,  "west-europe": 0.388,  "north-europe": 0.384  } },
  { sku: "f16s_v2", family: "f", generation: "v2", vCores: 16, isPremiumStorage: true , hourlyUsd: { "us-east": 0.677,  "us-east-2": 0.677,  "uk-south": 0.808,  "west-europe": 0.776,  "north-europe": 0.768  } },
] as const;

/**
 * License uplift rates — what Microsoft charges to rent the OS / SQL alongside
 * compute. These are the figures Jeannie's framework operates on:
 *   - Windows Server uplift: ~$0.046 per vCore per hour, flat 40% of compute
 *     for typical sizes (Jeannie Rule 3 — "It's always 40%").
 *   - SQL Server uplift: tiered by edition. Always quote as a RANGE
 *     (Enterprise ceiling, Standard floor) per Jeannie Rule 2.
 */
export const WINDOWS_UPLIFT_PER_CORE_HOUR_USD = 0.046;
export const WINDOWS_UPLIFT_PERCENT: Percent = pct(0.40);

export const SQL_UPLIFT_PER_CORE_HOUR_USD = {
  enterprise: 0.3978,
  standard: 0.1014,
  web: 0.0338,
} as const;

/* ---------------------------------------------------------------------- */
/* Lookup helpers                                                         */
/* ---------------------------------------------------------------------- */

/**
 * Normalise an Azure meter SKU name to our canonical id.
 * Examples:
 *   'D4s v5'     → 'd4s_v5'
 *   'D4 v3'      → 'd4_v3'
 *   'B2ms'       → 'b2ms'
 *   'E16as v5'   → 'e16as_v5'  (won't match — table holds intel-only for now)
 */
export function normaliseSkuToken(meter: string): string {
  return meter.trim().toLowerCase().replace(/\s+/g, "_");
}

export interface RateLookup {
  sku: SkuRate;
  region: Region;
  hourlyUsd: number;
}

/**
 * Look up an hourly rate. Returns null if SKU or region is unknown — caller
 * must classify the VM as `unknown-rate` rather than guess.
 */
export function lookupHourlyRate(
  meter: string,
  resourceLocation: string
): RateLookup | null {
  const skuId = normaliseSkuToken(meter);
  const region = normaliseRegion(resourceLocation);
  if (!region) return null;
  const sku = SKU_RATES.find((s) => s.sku === skuId);
  if (!sku) return null;
  const hourlyUsd = sku.hourlyUsd[region];
  if (hourlyUsd === undefined) return null;
  return { sku, region, hourlyUsd };
}
