#!/usr/bin/env python3
"""Fetch Linux PAYG hourly rates for our SKU set across our 5 regions
from the Azure Retail Pricing API and emit a TS-ready table."""
import urllib.parse, urllib.request, json, sys, time

REGIONS = {
    "us-east":     "eastus",
    "us-east-2":   "eastus2",
    "uk-south":    "uksouth",
    "west-europe": "westeurope",
    "north-europe":"northeurope",
}

# (canonical_id, family, generation, vCores, isPremiumStorage, armSkuName)
SKUS = [
    ("b2s",   "b","",   2,  True,  "Standard_B2s"),
    ("b2ms",  "b","",   2,  True,  "Standard_B2ms"),
    ("b4ms",  "b","",   4,  True,  "Standard_B4ms"),
    ("b8ms",  "b","",   8,  True,  "Standard_B8ms"),

    ("d2_v3",  "d","v3", 2,  False, "Standard_D2_v3"),
    ("d4_v3",  "d","v3", 4,  False, "Standard_D4_v3"),
    ("d8_v3",  "d","v3", 8,  False, "Standard_D8_v3"),
    ("d16_v3", "d","v3",16,  False, "Standard_D16_v3"),

    ("d2s_v4",  "d","v4", 2,  True,  "Standard_D2s_v4"),
    ("d4s_v4",  "d","v4", 4,  True,  "Standard_D4s_v4"),
    ("d8s_v4",  "d","v4", 8,  True,  "Standard_D8s_v4"),
    ("d16s_v4", "d","v4",16,  True,  "Standard_D16s_v4"),

    ("d2s_v5",  "d","v5", 2,  True,  "Standard_D2s_v5"),
    ("d4s_v5",  "d","v5", 4,  True,  "Standard_D4s_v5"),
    ("d8s_v5",  "d","v5", 8,  True,  "Standard_D8s_v5"),
    ("d16s_v5", "d","v5",16,  True,  "Standard_D16s_v5"),
    ("d32s_v5", "d","v5",32,  True,  "Standard_D32s_v5"),

    ("d2s_v6",  "d","v6", 2,  True,  "Standard_D2s_v6"),
    ("d4s_v6",  "d","v6", 4,  True,  "Standard_D4s_v6"),
    ("d8s_v6",  "d","v6", 8,  True,  "Standard_D8s_v6"),
    ("d16s_v6", "d","v6",16,  True,  "Standard_D16s_v6"),

    ("e2_v3",  "e","v3", 2,  False, "Standard_E2_v3"),
    ("e4_v3",  "e","v3", 4,  False, "Standard_E4_v3"),
    ("e8_v3",  "e","v3", 8,  False, "Standard_E8_v3"),
    ("e16_v3", "e","v3",16,  False, "Standard_E16_v3"),

    ("e2s_v4",  "e","v4", 2,  True,  "Standard_E2s_v4"),
    ("e4s_v4",  "e","v4", 4,  True,  "Standard_E4s_v4"),
    ("e8s_v4",  "e","v4", 8,  True,  "Standard_E8s_v4"),
    ("e16s_v4", "e","v4",16,  True,  "Standard_E16s_v4"),

    ("e2s_v5",  "e","v5", 2,  True,  "Standard_E2s_v5"),
    ("e4s_v5",  "e","v5", 4,  True,  "Standard_E4s_v5"),
    ("e8s_v5",  "e","v5", 8,  True,  "Standard_E8s_v5"),
    ("e16s_v5", "e","v5",16,  True,  "Standard_E16s_v5"),
    ("e32s_v5", "e","v5",32,  True,  "Standard_E32s_v5"),

    ("f2s_v2",  "f","v2", 2,  True,  "Standard_F2s_v2"),
    ("f4s_v2",  "f","v2", 4,  True,  "Standard_F4s_v2"),
    ("f8s_v2",  "f","v2", 8,  True,  "Standard_F8s_v2"),
    ("f16s_v2", "f","v2",16,  True,  "Standard_F16s_v2"),
]

def fetch_linux_payg(arm_sku, arm_region):
    """Return Linux PAYG hourly USD price, or None if not offered."""
    flt = (f"serviceName eq 'Virtual Machines' "
           f"and armRegionName eq '{arm_region}' "
           f"and armSkuName eq '{arm_sku}' "
           f"and priceType eq 'Consumption'")
    url = "https://prices.azure.com/api/retail/prices?$filter=" + urllib.parse.quote(flt)
    with urllib.request.urlopen(url, timeout=30) as r:
        data = json.load(r)
    # Linux PAYG: skuName == armSkuName (no " Spot" or " Low Priority" suffix);
    # productName does NOT contain "Windows".
    candidates = [
        i for i in data.get("Items", [])
        if i.get("armSkuName") == arm_sku
        and "Windows" not in i.get("productName", "")
        and "Low Priority" not in i.get("skuName", "")
        and "Spot" not in i.get("skuName", "")
        and i.get("type") == "Consumption"
        and i.get("unitOfMeasure", "").startswith("1 Hour")
    ]
    if not candidates:
        return None
    # Pick the most recent effectiveStartDate
    candidates.sort(key=lambda x: x.get("effectiveStartDate",""), reverse=True)
    return candidates[0]["retailPrice"]

results = {}
for canonical, fam, gen, vc, prem, arm in SKUS:
    results[canonical] = {"family":fam, "generation":gen, "vCores":vc, "isPremiumStorage":prem, "rates":{}}
    for region_key, arm_region in REGIONS.items():
        try:
            price = fetch_linux_payg(arm, arm_region)
        except Exception as e:
            price = None
            print(f"  ! {arm}/{arm_region} error: {e}", file=sys.stderr)
        results[canonical]["rates"][region_key] = price
        time.sleep(0.05)
    rates_str = " ".join(f"{r}={v}" for r,v in results[canonical]["rates"].items())
    print(f"{canonical:10s} {rates_str}", file=sys.stderr)

print(json.dumps(results, indent=2))
