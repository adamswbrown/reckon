"""
Proof-of-concept: port Microsoft FinOps-toolkit KQL detections to Python/pandas
running against an Azure invoice export (NMEF JAN 26).

Each `rule_*` function corresponds to a KQL file in
microsoft/finops-toolkit src/queries/catalog/, adapted to the columns this
invoice actually carries (no time series, no FOCUS PricingCategory/UnitPrice).

Usage: python run_rules.py <path-to-invoice.xlsx>
"""
from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd


# Canonical column names used by every rule in this module. The portal
# export schema drifts (Microsoft is migrating Cost Management exports
# toward the FOCUS spec), so each canonical name has a list of aliases we
# accept on ingest. Add new aliases here, never reach into rules.
CANONICAL_ALIASES: dict[str, tuple[str, ...]] = {
    "ResourceId":        ("ResourceId", "InstanceId", "x_ResourceId"),
    "ResourceType":      ("ResourceType", "ConsumedService", "x_ResourceType"),
    "ResourceLocation":  ("ResourceLocation", "Region", "RegionId", "RegionName", "ResourceLocationNormalized"),
    "ResourceGroupName": ("ResourceGroupName", "ResourceGroup", "x_ResourceGroupName"),
    "SubscriptionName":  ("SubscriptionName", "SubAccountName", "SubscriptionId", "InvoiceSectionName"),
    "ServiceName":       ("ServiceName", "ServiceCategory", "MeterCategory", "ServiceFamily"),
    "Meter":             ("Meter", "MeterName", "MeterSubCategory", "x_SkuMeterName", "SkuDescription"),
    "Tags":              ("Tags", "tags", "x_ResourceTags", "ResourceTags"),
    "CostUSD":           ("CostUSD", "BilledCostUSD", "EffectiveCostUSD", "PreTaxCostUSD"),
    "Cost":              ("Cost", "BilledCost", "EffectiveCost", "PreTaxCost"),
    "Currency":          ("Currency", "BillingCurrency", "BillingCurrencyCode", "PricingCurrency"),
}

REQUIRED = ("CostUSD",)  # everything else is nice-to-have


def normalize_columns(df: pd.DataFrame) -> pd.DataFrame:
    """Map whatever the export gave us onto our canonical names.

    Missing optional columns are added as NaN so rules can run without
    branching. Missing required columns raise — that's a real ingest bug.
    """
    rename: dict[str, str] = {}
    present_lower = {c.lower(): c for c in df.columns}
    for canonical, aliases in CANONICAL_ALIASES.items():
        for alias in aliases:
            if alias in df.columns:
                rename[alias] = canonical
                break
            if alias.lower() in present_lower:
                rename[present_lower[alias.lower()]] = canonical
                break

    out = df.rename(columns=rename).copy()
    for canonical in CANONICAL_ALIASES:
        if canonical not in out.columns:
            if canonical in REQUIRED:
                raise ValueError(
                    f"Required column '{canonical}' not found. "
                    f"Tried aliases: {CANONICAL_ALIASES[canonical]}. "
                    f"Got: {list(df.columns)}"
                )
            out[canonical] = pd.NA
    return out[list(CANONICAL_ALIASES.keys())]


def load(path: Path, sheet: str = "Data") -> pd.DataFrame:
    df = pd.read_excel(path, sheet_name=sheet, engine="openpyxl")
    df = normalize_columns(df)
    df["CostUSD"] = pd.to_numeric(df["CostUSD"], errors="coerce").fillna(0.0)
    return df


def fmt_money(x: float) -> str:
    return f"${x:,.2f}"


def pct(x: float, total: float) -> str:
    return f"{(x / total * 100):.1f}%" if total else "-"


# ---- Rules ----------------------------------------------------------------

def rule_top_services(df: pd.DataFrame, n: int = 10) -> pd.DataFrame:
    """Port of top-services-by-cost.kql"""
    g = (df.groupby("ServiceName", dropna=False)["CostUSD"].sum()
           .sort_values(ascending=False).head(n).reset_index())
    g["Share"] = g["CostUSD"] / df["CostUSD"].sum()
    return g


def rule_top_resource_groups(df: pd.DataFrame, n: int = 10) -> pd.DataFrame:
    """Port of top-resource-groups-by-cost.kql"""
    g = (df.groupby(["SubscriptionName", "ResourceGroupName"], dropna=False)["CostUSD"]
           .sum().sort_values(ascending=False).head(n).reset_index())
    g["Share"] = g["CostUSD"] / df["CostUSD"].sum()
    return g


def rule_top_resource_types(df: pd.DataFrame, n: int = 10) -> pd.DataFrame:
    """Port of top-resource-types-by-cost.kql"""
    g = (df.groupby("ResourceType", dropna=False)["CostUSD"].sum()
           .sort_values(ascending=False).head(n).reset_index())
    g["Share"] = g["CostUSD"] / df["CostUSD"].sum()
    return g


def rule_pareto_concentration(df: pd.DataFrame) -> dict:
    """Generic Pareto check: % of spend in top 20% of resources."""
    by_resource = (df.groupby("ResourceId", dropna=False)["CostUSD"].sum()
                     .sort_values(ascending=False))
    by_resource = by_resource[by_resource > 0]
    n = len(by_resource)
    top20_n = max(1, int(n * 0.20))
    top20_cost = by_resource.head(top20_n).sum()
    total = by_resource.sum()
    return {
        "resources_with_spend": n,
        "top20pct_count": top20_n,
        "top20pct_cost": top20_cost,
        "top20pct_share": top20_cost / total if total else 0.0,
        "total": total,
    }


def rule_region_sprawl(df: pd.DataFrame) -> pd.DataFrame:
    """Adapted from cost-by-region-trend.kql (no time dimension available)."""
    g = (df.groupby("ResourceLocation", dropna=False)["CostUSD"].sum()
           .sort_values(ascending=False).reset_index())
    g["Share"] = g["CostUSD"] / df["CostUSD"].sum()
    return g


def rule_meter_hotspots_within_service(df: pd.DataFrame, service: str, n: int = 5) -> pd.DataFrame:
    """Adapted from service-price-benchmarking.kql — without UnitPrice we
    can only show meter-level cost concentration inside one service."""
    sub = df[df["ServiceName"] == service]
    g = (sub.groupby("Meter", dropna=False)["CostUSD"].sum()
            .sort_values(ascending=False).head(n).reset_index())
    g["Share"] = g["CostUSD"] / sub["CostUSD"].sum()
    return g


def rule_orphan_region(df: pd.DataFrame) -> pd.DataFrame:
    """Custom rule: cost landing in 'unassigned' / 'unknown' / 'global' is
    typically support, marketplace, or unattached metadata — flag it."""
    mask = df["ResourceLocation"].isin(["unassigned", "unknown", "global"])
    g = (df[mask].groupby(["ResourceLocation", "ServiceName"], dropna=False)["CostUSD"]
           .sum().sort_values(ascending=False).reset_index())
    return g


def rule_tag_coverage(df: pd.DataFrame) -> dict:
    """Custom rule (governance): % of cost on resources with no tags.
    Closest KQL analogue is from the governance workbook."""
    has_tag = df["Tags"].notna() & (df["Tags"].astype(str).str.strip() != "")
    total = df["CostUSD"].sum()
    tagged_cost = df.loc[has_tag, "CostUSD"].sum()
    return {
        "total_cost": total,
        "tagged_cost": tagged_cost,
        "untagged_cost": total - tagged_cost,
        "tag_coverage_share": tagged_cost / total if total else 0.0,
    }


def rule_subscription_concentration(df: pd.DataFrame) -> pd.DataFrame:
    g = (df.groupby("SubscriptionName", dropna=False)["CostUSD"].sum()
           .sort_values(ascending=False).reset_index())
    g["Share"] = g["CostUSD"] / df["CostUSD"].sum()
    return g


def rule_zero_cost_noise(df: pd.DataFrame) -> dict:
    """Sanity rule — count line items with non-positive cost (rounding,
    refunds, $0 reservations). Useful for invoice integrity checks."""
    neg = (df["CostUSD"] < 0).sum()
    zero = (df["CostUSD"] == 0).sum()
    return {"negative_lines": int(neg), "zero_lines": int(zero), "total_lines": len(df)}


# ---- Reporting ------------------------------------------------------------

def section(title: str) -> None:
    print("\n" + "=" * 78)
    print(title)
    print("=" * 78)


def print_df(df: pd.DataFrame, money_cols=("CostUSD",), share_cols=("Share",)) -> None:
    out = df.copy()
    for c in money_cols:
        if c in out.columns:
            out[c] = out[c].map(fmt_money)
    for c in share_cols:
        if c in out.columns:
            out[c] = out[c].map(lambda v: f"{v*100:.1f}%")
    print(out.to_string(index=False))


def main(path: Path) -> None:
    df = load(path)
    total = df["CostUSD"].sum()

    section(f"INVOICE: {path.name}")
    print(f"Lines: {len(df):,}   Total: {fmt_money(total)}   "
          f"Subs: {df['SubscriptionName'].nunique()}   "
          f"RGs: {df['ResourceGroupName'].nunique()}")

    section("Rule 1 — Top services by cost (Pareto / hotspot)")
    print_df(rule_top_services(df))

    section("Rule 2 — Top resource groups by cost")
    print_df(rule_top_resource_groups(df))

    section("Rule 3 — Top resource types by cost")
    print_df(rule_top_resource_types(df))

    section("Rule 4 — Resource-level Pareto (80/20)")
    p = rule_pareto_concentration(df)
    print(f"Resources with spend: {p['resources_with_spend']:,}")
    print(f"Top 20% ({p['top20pct_count']:,} resources) account for "
          f"{fmt_money(p['top20pct_cost'])} = {p['top20pct_share']*100:.1f}% of spend")

    section("Rule 5 — Region sprawl")
    print_df(rule_region_sprawl(df))

    section("Rule 6 — Orphan / global / unknown region cost")
    print_df(rule_orphan_region(df))

    section("Rule 7 — Subscription concentration")
    print_df(rule_subscription_concentration(df))

    section("Rule 8 — Tag coverage (governance)")
    t = rule_tag_coverage(df)
    print(f"Tagged cost:   {fmt_money(t['tagged_cost'])} "
          f"({t['tag_coverage_share']*100:.1f}%)")
    print(f"Untagged cost: {fmt_money(t['untagged_cost'])} "
          f"({(1-t['tag_coverage_share'])*100:.1f}%)")

    section("Rule 9 — Meter hotspots within top service")
    top_service = rule_top_services(df, 1).iloc[0]["ServiceName"]
    print(f"Service: {top_service}")
    print_df(rule_meter_hotspots_within_service(df, top_service))

    section("Rule 10 — Invoice integrity (zero / negative lines)")
    z = rule_zero_cost_noise(df)
    print(f"Negative lines: {z['negative_lines']:,}   "
          f"Zero lines: {z['zero_lines']:,}   "
          f"Total lines: {z['total_lines']:,}")


if __name__ == "__main__":
    p = Path(sys.argv[1] if len(sys.argv) > 1
             else "/Users/adambrown/Developer/JJ/NMEF Azure Invoice JAN 26.xlsx")
    main(p)
