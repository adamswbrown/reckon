#!/usr/bin/env python3
"""
Generates a synthetic DMC Azure-mode scan fixture for the Contoso environment.

Matches the on-disk shape of an Intel Cloud Optimizer / DMC Azure scan output,
exactly as observed in arae_engine/test_fixtures/Azure/<scan_id>/. Used to
exercise the JJ ingestion engine before real customer scans land.

Run:
    python3 tools/gen-synthetic-dmc-scan.py [--out DIR]

Default output: test-fixtures/dmc-azure-contoso/<scan_id>/
"""
from __future__ import annotations

import argparse
import hashlib
import json
import random
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

# ---------------------------------------------------------------------------
# Determinism — same seed → identical bytes.
# ---------------------------------------------------------------------------
SEED = "contoso-azure-2026-q1"
rng = random.Random(SEED)


def det_uuid(label: str) -> str:
    h = hashlib.md5(f"{SEED}:{label}".encode()).digest()
    return str(uuid.UUID(bytes=h))


# ---------------------------------------------------------------------------
# Scan window — 90 days ending at a fixed cutoff (deterministic).
# ---------------------------------------------------------------------------
SCAN_END = datetime(2026, 4, 27, 9, 30, 12, 184273, tzinfo=timezone.utc)
DURATION_DAYS = 90
GRANULARITY_MIN = 15
COLLECTION_END = SCAN_END
COLLECTION_START = COLLECTION_END - timedelta(days=DURATION_DAYS)
MAX_DATA_POINTS = DURATION_DAYS * 24 * (60 // GRANULARITY_MIN)  # 8640

SCAN_ID = det_uuid("scan")
SUBSCRIPTION_ID = det_uuid("subscription")
SUBSCRIPTION_NAME = "Contoso-Production-Hub"
DMC_VERSION = "1.3.5"

# Two-region Contoso footprint.
REGIONS = ["eastus", "westeurope"]

# Tier templates: defines workload pattern, sizing, count per tier.
# Each tier produces N VMs with predictable shapes that exercise downstream rules.
TIERS = [
    # name, count, region, rg_template, size_pool, os, power profile, cpu profile, mem profile, disk profile
    {
        "name": "prod-web",
        "count": 6,
        "region": "eastus",
        "rg": "rg-contoso-prod-web-eus",
        "sizes": ["Standard_D8s_v5", "Standard_D8s_v5", "Standard_D16s_v5"],
        "os": "linux",
        "power": (98.0, 100.0),
        "cpu": (35.0, 55.0, 92.0),       # avg, p95, peak
        "mem": (52.0, 68.0),             # avg, p95
        "disks": [("os", 64, "Premium_LRS"), ("data", 256, "Premium_LRS")],
    },
    {
        "name": "prod-app",
        "count": 10,
        "region": "eastus",
        "rg": "rg-contoso-prod-app-eus",
        "sizes": ["Standard_D4s_v5", "Standard_D8s_v5"],
        "os": "linux",
        "power": (97.0, 100.0),
        "cpu": (22.0, 38.0, 84.0),
        "mem": (44.0, 58.0),
        "disks": [("os", 64, "Premium_LRS")],
    },
    {
        "name": "prod-sql",
        "count": 4,
        "region": "eastus",
        "rg": "rg-contoso-prod-data-eus",
        "sizes": ["Standard_E8ds_v5", "Standard_E16ds_v5"],
        "os": "windows",
        "power": (100.0, 100.0),
        "cpu": (8.0, 18.0, 64.0),
        "mem": (78.0, 88.0),
        "disks": [("os", 128, "Premium_LRS"), ("data", 1024, "Premium_LRS"), ("log", 256, "Premium_LRS")],
    },
    {
        "name": "prod-eu",
        "count": 4,
        "region": "westeurope",
        "rg": "rg-contoso-prod-app-weu",
        "sizes": ["Standard_D4s_v5", "Standard_D8s_v5"],
        "os": "linux",
        "power": (95.0, 100.0),
        "cpu": (18.0, 32.0, 78.0),
        "mem": (40.0, 55.0),
        "disks": [("os", 64, "Premium_LRS")],
    },
    {
        "name": "uat",
        "count": 8,
        "region": "eastus",
        "rg": "rg-contoso-uat-eus",
        "sizes": ["Standard_D4s_v5", "Standard_B4ms"],
        "os": "linux",
        "power": (60.0, 85.0),
        "cpu": (5.0, 12.0, 60.0),
        "mem": (25.0, 38.0),
        "disks": [("os", 64, "StandardSSD_LRS")],
    },
    {
        "name": "dev",
        "count": 12,
        "region": "eastus",
        "rg": "rg-contoso-dev-eus",
        "sizes": ["Standard_B4ms", "Standard_B2s", "Standard_D4s_v5"],
        "os": "windows",
        "power": (15.0, 50.0),
        "cpu": (3.0, 9.0, 55.0),
        "mem": (28.0, 42.0),
        "disks": [("os", 128, "StandardSSD_LRS"), ("data", 256, "Standard_LRS")],
    },
    {
        "name": "oversized-candidates",
        "count": 4,
        "region": "eastus",
        "rg": "rg-contoso-prod-legacy-eus",
        "sizes": ["Standard_D32s_v5", "Standard_E32ds_v5"],
        "os": "windows",
        "power": (100.0, 100.0),
        "cpu": (1.5, 3.5, 18.0),         # absurdly low → right-sizing candidate
        "mem": (12.0, 22.0),
        "disks": [("os", 128, "Premium_LRS"), ("data", 512, "Premium_LRS")],
    },
    {
        "name": "dormant",
        "count": 5,
        "region": "eastus",
        "rg": "rg-contoso-archive-eus",
        "sizes": ["Standard_D4s_v5", "Standard_B4ms"],
        "os": "windows",
        "power": (0.0, 0.0),             # deallocated
        "cpu": (0.0, 0.0, 0.0),
        "mem": (0.0, 0.0),
        "disks": [("os", 128, "Standard_LRS"), ("data", 512, "Standard_LRS")],
    },
]

# VM size → (cores, memory_mib).
SIZE_CATALOG = {
    "Standard_B2s":     (2, 4096),
    "Standard_B4ms":    (4, 16384),
    "Standard_D4s_v5":  (4, 16384),
    "Standard_D8s_v5":  (8, 32768),
    "Standard_D16s_v5": (16, 65536),
    "Standard_D32s_v5": (32, 131072),
    "Standard_E8ds_v5": (8, 65536),
    "Standard_E16ds_v5": (16, 131072),
    "Standard_E32ds_v5": (32, 262144),
}


def random_in(lo: float, hi: float) -> float:
    return round(rng.uniform(lo, hi), 2)


def vm_name(tier: str, index: int) -> str:
    short = {
        "prod-web": "pwb",
        "prod-app": "pap",
        "prod-sql": "psq",
        "prod-eu": "peu",
        "uat":     "uat",
        "dev":     "dev",
        "oversized-candidates": "leg",
        "dormant": "arc",
    }[tier]
    return f"vmctso{short}{index:03d}"


def build_disk_data(disks_spec, vm: str, start: str, end: str) -> dict:
    disks = {}
    for i, (kind, gb, storage) in enumerate(disks_spec):
        nm = f"{vm}-{kind}" if kind == "os" else f"{vm}-{kind}-{i:02d}"
        d = {"disk_name": nm, "capacity_gb": gb, "disk_type": kind, "storage_type": storage}
        if kind != "os":
            d["lun"] = i
        disks[nm] = d
    return {
        "disks": disks,
        "controller_mapping": {},
        "disk_metrics": {
            "aggregate": {
                "read_avg_kbps":  random_in(50, 8000),
                "read_p95_kbps":  random_in(800, 30000),
                "write_avg_kbps": random_in(120, 9000),
                "write_p95_kbps": random_in(2000, 35000),
                "read_iops":      random_in(0.05, 6.0),
                "read_iops_p95":  random_in(0.05, 18.0),
                "write_iops":     random_in(0.5, 8.0),
                "write_iops_p95": random_in(0.5, 22.0),
            }
        },
        "filesystems": [],
        "collection_start_time": start,
        "collection_end_time": end,
    }


def build_network_data(start: str, end: str) -> dict:
    octet = rng.randint(2, 250)
    return {
        "adapters": {},
        "ip_addresses": f"10.{rng.randint(0, 31)}.{rng.randint(0, 255)}.{octet}",
        "metrics": {
            "aggregate": {
                "net.received.average":      random_in(120, 4500),
                "net.received.p95":          random_in(300, 8000),
                "net.received.total_gb":     round(random_in(0.05, 12.0), 4),
                "net.transmitted.average":   random_in(180, 6000),
                "net.transmitted.p95":       random_in(400, 9000),
                "net.transmitted.total_gb":  round(random_in(0.05, 14.0), 4),
            }
        },
        "collection_start_time": start,
        "collection_end_time": end,
    }


def build_metric_result(vm: str, tier: dict, sub_id: str) -> dict:
    size = rng.choice(tier["sizes"])
    cores, memory = SIZE_CATALOG[size]
    p_lo, p_hi = tier["power"]
    powered_on_pct = round(rng.uniform(p_lo, p_hi), 2)
    powered_on_hours = round(DURATION_DAYS * 24 * powered_on_pct / 100.0, 2)
    data_points = int(MAX_DATA_POINTS * powered_on_pct / 100.0)
    cpu_avg, cpu_p95, cpu_peak = tier["cpu"]
    mem_avg, mem_p95 = tier["mem"]
    # Slight per-VM jitter so VMs in the same tier aren't identical.
    jitter = lambda b: round(b * rng.uniform(0.85, 1.15), 2) if b else 0.0
    power_state = "running" if powered_on_pct > 0 else "deallocated"
    start_iso = COLLECTION_START.isoformat()
    end_iso = COLLECTION_END.isoformat()
    return {
        vm: {
            "server_name": vm,
            "OSName": "Unknown",
            "boot_type": None,
            "bios_uuid": det_uuid(f"vm:{vm}"),
            "memory": memory,
            "number_of_cores": cores,
            "number_of_disks": len(tier["disks"]),
            "number_of_nw_adapters": 1,
            "server_type": "Virtual",
            "hypervisor": "Azure",
            "power_state": power_state,
            "vm_size": size,
            "azure_region": tier["region"],
            "azure_resource_group": tier["rg"],
            "disk_data": build_disk_data(tier["disks"], vm, start_iso, end_iso),
            "network_data": build_network_data(start_iso, end_iso),
            "cpu": {
                "metric_value": jitter(cpu_avg),
                "metric_value_p95": jitter(cpu_p95),
                "metric_value_peak": jitter(cpu_peak),
                "agg_strategy": "average",
                "collection_start_time": start_iso,
                "collection_end_time": end_iso,
                "data_points": data_points,
                "powered_on_hours": powered_on_hours,
                "powered_on_percent": powered_on_pct,
            },
            "memory_pct": {
                "metric_value": jitter(mem_avg),
                "metric_value_p95": jitter(mem_p95),
                "agg_strategy": "average",
                "collection_start_time": start_iso,
                "collection_end_time": end_iso,
                "data_points": data_points,
            },
            "metric_collection": {
                "duration_days": DURATION_DAYS,
                "granularity_minutes": GRANULARITY_MIN,
                "source": "azure_monitor",
            },
        }
    }


def build_health_status(vm_size: str, cpu_avg: float, mem_avg: float, power_state: str) -> dict:
    cpu_alert = cpu_avg > 85.0
    mem_alert = mem_avg > 75.0
    if power_state == "deallocated":
        return {
            "overall": False,
            "power_state": {"status": False, "message": "VM is deallocated", "metrics": {}},
            "tools_status": {"status": False, "message": "Cannot verify VM Agent — VM not running", "metrics": {}},
            "cpu": {"status": False, "message": f"CPU usage {cpu_avg:.1f}% exceeds threshold 85%" if cpu_alert
                    else "Insufficient guest data — VM not running", "metrics": {"cpu_current": cpu_avg}},
            "memory": {"status": not mem_alert, "message": f"Memory usage {mem_avg:.1f}% (threshold: 75%)",
                       "metrics": {"memory_current": mem_avg}},
            "disk": {"status": True, "message": "Not pre-checked (no guest disk data)", "metrics": {}},
        }
    return {
        "overall": not (cpu_alert or mem_alert),
        "power_state": {"status": True, "message": "VM is running", "metrics": {}},
        "tools_status": {"status": True, "message": "VM Agent reachable", "metrics": {}},
        "cpu": {
            "status": not cpu_alert,
            "message": (f"CPU usage {cpu_avg:.1f}% exceeds threshold 85%" if cpu_alert
                        else f"CPU usage {cpu_avg:.1f}% (threshold: 85%)"),
            "metrics": {"cpu_current": cpu_avg},
        },
        "memory": {
            "status": not mem_alert,
            "message": f"Memory usage {mem_avg:.1f}% (threshold: 75%)",
            "metrics": {"memory_current": mem_avg},
        },
        "disk": {"status": True, "message": "Disk usage within bounds", "metrics": {}},
    }


def build_metadata(vm: str, vm_uuid: str, tier: dict, sub_id: str, health: dict, scan_id: str) -> dict:
    power_state = "deallocated" if tier["power"][1] == 0 else "running"
    overall_ok = health["overall"]
    cpu_msg = health["cpu"]["message"]
    error_msgs = []
    if power_state == "deallocated":
        error_msgs.append("VM is deallocated")
        error_msgs.append("Cannot verify VM Agent — VM not running")
    if not health["cpu"]["status"]:
        error_msgs.append(cpu_msg)
    return {
        "vm_name": vm,
        "vm_uuid": vm_uuid,
        "vm_bios_uuid": vm_uuid,
        "power_state": power_state,
        "os_type": tier["os"],
        "guest_os_description": "Unknown",
        "azure_subscription": sub_id,
        "azure_resource_group": tier["rg"],
        "azure_region": tier["region"],
        "machine_id": f"{sub_id}-{vm}",
        "output_dir": f"{scan_id}\\{sub_id}\\{vm_uuid}",
        "health_status": health,
        "status": "partial" if not overall_ok else "completed",
        "error_message": ("Health check failed: " + "; ".join(error_msgs) + ". Skipping guest scans."
                          if error_msgs else ""),
        "scan_results": {
            "metric": "success",
            "software": "failed" if power_state == "deallocated" or not overall_ok else "success",
            "network": "failed" if power_state == "deallocated" or not overall_ok else "success",
            "db": "failed" if power_state == "deallocated" or not overall_ok else "success",
        },
    }


def build_vm_log(vm: str, vm_uuid: str, scan_id: str, sub_id: str, output_path: str,
                 power_state: str, cpu_avg: float, mem_avg: float, run_started: datetime) -> str:
    t = run_started + timedelta(seconds=rng.randint(120, 240))

    def stamp(dt: datetime) -> str:
        return dt.strftime("%Y-%m-%d %H:%M:%S,") + f"{dt.microsecond // 1000:03d}"
    L = []
    L.append(f"{stamp(t)} - dmc-cli.vm.{vm} - INFO - Starting metric scan for VM: {vm}")
    t += timedelta(seconds=2)
    L.append(f"{stamp(t)} - dmc-cli.vm.{vm} - INFO - Using batch-prefetched metrics for '{vm}'")
    t += timedelta(milliseconds=20)
    L.append(f"{stamp(t)} - dmc-cli.vm.{vm} - INFO - Saved metric result to {output_path}")
    if power_state == "deallocated":
        t += timedelta(milliseconds=10)
        L.append(f"{stamp(t)} - dmc-cli.vm.{vm} - WARNING - VM deallocated; skipping guest scans.")
    else:
        t += timedelta(milliseconds=10)
        L.append(f"{stamp(t)} - dmc-cli.vm.{vm} - DEBUG - 7-day average CPU for health check: {cpu_avg:.2f}%")
        L.append(f"{stamp(t)} - dmc-cli.vm.{vm} - DEBUG - 7-day average memory for health check: {mem_avg:.2f}%")
        t += timedelta(seconds=1)
        if cpu_avg > 85:
            L.append(f"{stamp(t)} - dmc-cli.vm.{vm} - WARNING - CPU health check failed: {cpu_avg:.1f}% > 85% threshold")
        L.append(f"{stamp(t)} - dmc-cli.vm.{vm} - INFO - Software scan completed")
        L.append(f"{stamp(t)} - dmc-cli.vm.{vm} - INFO - Network scan completed")
        L.append(f"{stamp(t)} - dmc-cli.vm.{vm} - INFO - Database scan completed")
    return "\n".join(L) + "\n"


def build_resource_summary(scan_id: str, sub_id: str, vm_count: int, disk_count: int) -> dict:
    return {
        "scan_id": scan_id,
        "subscription_id": sub_id,
        "scan_timestamp": (SCAN_END + timedelta(minutes=5)).isoformat(),
        "total_types": 32,
        "succeeded": 32,
        "failed": 0,
        "results": {
            "network_interfaces":      {"status": "success", "count": vm_count + 12, "errors": 0},
            "network_security_groups": {"status": "success", "count": 24, "errors": 0},
            "virtual_networks":        {"status": "success", "count": 6,  "errors": 0},
            "public_ip_addresses":     {"status": "success", "count": 18, "errors": 0},
            "application_gateways":    {"status": "success", "count": 4,  "errors": 0},
            "load_balancers":          {"status": "success", "count": 3,  "errors": 0},
            "nat_gateways":            {"status": "success", "count": 2,  "errors": 0},
            "azure_firewalls":         {"status": "success", "count": 1,  "errors": 0},
            "front_doors":             {"status": "success", "count": 1,  "errors": 0},
            "virtual_machines":        {"status": "success", "count": vm_count, "errors": 0},
            "managed_disks":           {"status": "success", "count": disk_count, "errors": 0},
            "vmss":                    {"status": "success", "count": 2,  "errors": 0},
            "aks_clusters":            {"status": "success", "count": 1,  "errors": 0},
            "storage_accounts":        {"status": "success", "count": 38, "errors": 0},
            "app_service_plans":       {"status": "success", "count": 9,  "errors": 0},
            "web_apps":                {"status": "success", "count": 18, "errors": 0},
            "container_instances":     {"status": "success", "count": 0,  "errors": 0},
            "container_registries":    {"status": "success", "count": 2,  "errors": 0},
            "key_vaults":              {"status": "success", "count": 14, "errors": 0},
            "sql_servers":             {"status": "success", "count": 3,  "errors": 0},
            "sql_managed_instances":   {"status": "success", "count": 1,  "errors": 0},
            "postgresql_servers":      {"status": "success", "count": 2,  "errors": 0},
            "mysql_servers":           {"status": "success", "count": 0,  "errors": 0},
            "cosmosdb_accounts":       {"status": "success", "count": 1,  "errors": 0},
            "recovery_vaults":         {"status": "success", "count": 4,  "errors": 0},
            "event_hub_namespaces":    {"status": "success", "count": 1,  "errors": 0},
            "servicebus_namespaces":   {"status": "success", "count": 2,  "errors": 0},
            "redis_caches":            {"status": "success", "count": 1,  "errors": 0},
            "dns_zones":               {"status": "success", "count": 2,  "errors": 0},
            "private_dns_zones":       {"status": "success", "count": 11, "errors": 0},
            "log_analytics_workspaces":{"status": "success", "count": 3,  "errors": 0},
            "application_insights":    {"status": "success", "count": 9,  "errors": 0},
        },
    }


def build_runlog(scan_id: str, sub_id: str, vm_names: list[str], start: datetime) -> str:

    def stamp(dt: datetime) -> str:
        return dt.strftime("%Y-%m-%d %H:%M:%S,") + f"{dt.microsecond // 1000:03d}"

    t = start
    L = []
    L.append(f"{stamp(t)} - dmc-cli - INFO - Logging initialized. Writing to file: C:\\temp\\scans\\{scan_id}\\runlog.log")
    L.append(f"{stamp(t)} - dmc-cli - INFO - Starting dmc operation")
    t += timedelta(milliseconds=1)
    L.append(f"{stamp(t)} - dmc-cli - INFO - DMC CLI version: {DMC_VERSION}")
    L.append(f"{stamp(t)} - dmc-cli - INFO - Running Azure scan with modes: metric, software, network, db, resource, max workers: 5, scan id: {scan_id}")
    t += timedelta(seconds=2, milliseconds=540)
    L.append(f"{stamp(t)} - dmc-cli - INFO - Connected to Azure subscription: {sub_id}")
    t += timedelta(milliseconds=3)
    L.append(f"{stamp(t)} - dmc-cli - INFO - Starting VM discovery...")
    L.append(f"{stamp(t)} - dmc-cli - INFO - Enumerating virtual machines...")
    t += timedelta(seconds=3, milliseconds=781)
    L.append(f"{stamp(t)} - dmc-cli - INFO - Found {len(vm_names)} VM(s), collecting details...")
    for i, name in enumerate(vm_names, 1):
        if i == 1 or i % 10 == 0 or i == len(vm_names):
            t += timedelta(seconds=rng.randint(8, 14))
            L.append(f"{stamp(t)} - dmc-cli - INFO -   Processing VM {i}/{len(vm_names)}: {name}")
    t += timedelta(seconds=12)
    L.append(f"{stamp(t)} - dmc-cli - INFO - VM details collection complete")
    t += timedelta(seconds=2)
    L.append(f"{stamp(t)} - dmc-cli - INFO - Resource scan starting (32 types)...")
    t += timedelta(minutes=4, seconds=33)
    L.append(f"{stamp(t)} - dmc-cli - INFO - Resource scan completed")
    L.append(f"{stamp(t)} - dmc-cli - INFO - Scan {scan_id} completed successfully")
    return "\n".join(L) + "\n"


def main():
    ap = argparse.ArgumentParser()
    here = Path(__file__).resolve().parent.parent
    default_out = here / "test-fixtures" / "dmc-azure-contoso"
    ap.add_argument("--out", type=Path, default=default_out)
    args = ap.parse_args()

    scan_root = args.out / SCAN_ID
    scan_root.mkdir(parents=True, exist_ok=True)
    sub_dir = scan_root / SUBSCRIPTION_ID
    sub_dir.mkdir(parents=True, exist_ok=True)
    (scan_root / "azure_resources" / SUBSCRIPTION_ID).mkdir(parents=True, exist_ok=True)

    vm_results = []
    vm_names_in_order = []
    disk_count_total = 0

    for tier in TIERS:
        for i in range(1, tier["count"] + 1):
            name = vm_name(tier["name"], i)
            vm_names_in_order.append(name)
            vm_uuid = det_uuid(f"vm:{name}")
            vm_dir = sub_dir / vm_uuid
            vm_dir.mkdir(parents=True, exist_ok=True)

            metric = build_metric_result(name, tier, SUBSCRIPTION_ID)
            mr_payload = list(metric.values())[0]
            disk_count_total += mr_payload["number_of_disks"]
            health = build_health_status(
                mr_payload["vm_size"],
                mr_payload["cpu"]["metric_value"],
                mr_payload["memory_pct"]["metric_value"],
                mr_payload["power_state"],
            )
            metadata = build_metadata(name, vm_uuid, tier, SUBSCRIPTION_ID, health, SCAN_ID)
            output_path = (
                f"C:\\temp\\scans\\{SCAN_ID}\\{SUBSCRIPTION_ID}\\{vm_uuid}\\metric-result.json"
            )
            log = build_vm_log(
                name, vm_uuid, SCAN_ID, SUBSCRIPTION_ID, output_path,
                mr_payload["power_state"], mr_payload["cpu"]["metric_value"],
                mr_payload["memory_pct"]["metric_value"], SCAN_END - timedelta(minutes=2),
            )

            (vm_dir / "metadata.json").write_text(json.dumps(metadata, indent=4))
            (vm_dir / "metric-result.json").write_text(json.dumps(metric, indent=2))
            (vm_dir / "vm.log").write_text(log)

            # Top-level summary uses the lighter health_status shape:
            # {status, message} per check — `metrics` lives on metadata.json only.
            summary_health = {
                k: {"status": v["status"], "message": v["message"]}
                for k, v in health.items() if k != "overall"
            }
            summary_health["overall"] = health["overall"]
            # Re-order to keep `overall` first (matches source).
            summary_health = {"overall": summary_health.pop("overall"), **summary_health}
            vm_results.append({
                "vm_name": name,
                "vm_uuid": vm_uuid,
                "vm_bios_uuid": vm_uuid,
                "power_state": mr_payload["power_state"],
                "os_type": tier["os"],
                "guest_os_description": "Unknown",
                "azure_subscription": SUBSCRIPTION_ID,
                "azure_resource_group": tier["rg"],
                "azure_region": tier["region"],
                "machine_id": metadata["machine_id"],
                "output_dir": metadata["output_dir"],
                "health_status": summary_health,
                "status": metadata["status"],
                "error_message": metadata["error_message"],
                "scan_results": metadata["scan_results"],
            })

    # Top-level scan summary.
    scan_summary = {
        "scan_id": SCAN_ID,
        "scan_type": "azure",
        "start_time": (SCAN_END - timedelta(minutes=6, seconds=14)).replace(tzinfo=None).isoformat(),
        "end_time": SCAN_END.replace(tzinfo=None).isoformat(),
        "status": "completed",
        "scan_mode": ["metric", "software", "network", "db", "resource"],
        "subscription_id": SUBSCRIPTION_ID,
        "subscription_name": SUBSCRIPTION_NAME,
        "total_vms": len(vm_results),
        "completed_vms": len(vm_results),
        "errored_vms": 0,
        "skipped_vms": 0,
        "vm_results": vm_results,
        "resource_scan_summary": build_resource_summary(SCAN_ID, SUBSCRIPTION_ID, len(vm_results), disk_count_total),
        "dmc_version": DMC_VERSION,
    }

    (scan_root / f"{SCAN_ID}.json").write_text(json.dumps(scan_summary, indent=2))
    (scan_root / "runlog.log").write_text(
        build_runlog(SCAN_ID, SUBSCRIPTION_ID, vm_names_in_order, SCAN_END - timedelta(minutes=6))
    )

    print(f"Scan ID:        {SCAN_ID}")
    print(f"Subscription:   {SUBSCRIPTION_ID}  ({SUBSCRIPTION_NAME})")
    print(f"VMs:            {len(vm_results)}  ({sum(1 for v in vm_results if v['power_state'] == 'running')} running, "
          f"{sum(1 for v in vm_results if v['power_state'] == 'deallocated')} deallocated)")
    print(f"Disks:          {disk_count_total}")
    print(f"Window:         {COLLECTION_START.date()} → {COLLECTION_END.date()} ({DURATION_DAYS} days, {GRANULARITY_MIN}-min granularity)")
    print(f"Output:         {scan_root}")


if __name__ == "__main__":
    main()
