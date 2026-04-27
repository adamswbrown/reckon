/**
 * Parser for DMC Azure-mode scan output directories.
 *
 * Layout consumed (matches synthetic + real fixtures):
 *
 *   <scan_id>/
 *     <scan_id>.json                 # top-level scan summary
 *     runlog.log
 *     azure_resources/<sub>/...
 *     <subscription_id>/
 *       <vm_uuid>/
 *         metadata.json
 *         metric-result.json
 *         vm.log
 *
 * The parser is forgiving: missing optional metric blocks (e.g. cpu on
 * a VM with no telemetry) collapse to `null` rather than throwing.
 * Required-but-missing structural fields throw, since they indicate a
 * different output shape than DMC Azure-mode.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import type {
  DmcCpuMetric,
  DmcDisk,
  DmcDiskMetrics,
  DmcMemMetric,
  DmcNetMetric,
  DmcResourceCounts,
  DmcScan,
  DmcScanMeta,
  DmcVm,
  PowerState,
} from "./types";

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function asPower(v: unknown): PowerState {
  const s = str(v).toLowerCase();
  if (s === "running" || s === "deallocated" || s === "stopped") return s;
  return "unknown";
}

function findScanRoot(input: string): string {
  // Accept either the scan dir itself or its parent.
  const st = statSync(input);
  if (!st.isDirectory()) {
    throw new Error(`DMC scan path must be a directory: ${input}`);
  }
  // Direct hit: contains <scanId>.json at the top level.
  const direct = readdirSync(input).find((f) => /^[0-9a-f-]{36}\.json$/i.test(f));
  if (direct) return input;
  // Parent → step into single child if shape matches.
  const children = readdirSync(input).filter((c) => statSync(join(input, c)).isDirectory());
  for (const c of children) {
    const candidate = join(input, c);
    const inner = readdirSync(candidate);
    if (inner.find((f) => /^[0-9a-f-]{36}\.json$/i.test(f))) return candidate;
  }
  throw new Error(`No DMC scan summary JSON found under ${input}`);
}

function loadScanSummary(scanRoot: string): { id: string; raw: Record<string, unknown> } {
  const summary = readdirSync(scanRoot).find((f) => /^[0-9a-f-]{36}\.json$/i.test(f));
  if (!summary) throw new Error(`Missing scan summary JSON in ${scanRoot}`);
  const raw = readJson(join(scanRoot, summary));
  if (!isObj(raw)) throw new Error(`Scan summary is not an object: ${summary}`);
  return { id: basename(summary, ".json"), raw };
}

function parseMeta(raw: Record<string, unknown>): DmcScanMeta {
  return {
    scanId: str(raw.scan_id),
    scanType: "azure",
    startTime: str(raw.start_time),
    endTime: str(raw.end_time),
    status: str(raw.status),
    scanMode: Array.isArray(raw.scan_mode) ? raw.scan_mode.map(String) : [],
    subscriptionId: str(raw.subscription_id),
    subscriptionName: str(raw.subscription_name),
    totalVms: num(raw.total_vms),
    completedVms: num(raw.completed_vms),
    erroredVms: num(raw.errored_vms),
    skippedVms: num(raw.skipped_vms),
    dmcVersion: str(raw.dmc_version),
  };
}

function parseDisks(diskData: unknown): {
  disks: DmcDisk[];
  metrics: DmcDiskMetrics | null;
} {
  if (!isObj(diskData)) return { disks: [], metrics: null };
  const disksRaw = isObj(diskData.disks) ? diskData.disks : {};
  const disks: DmcDisk[] = Object.values(disksRaw)
    .filter(isObj)
    .map((d) => ({
      name: str(d.disk_name),
      capacityGb: num(d.capacity_gb),
      diskType: str(d.disk_type),
      storageType: typeof d.storage_type === "string" ? d.storage_type : null,
      lun: typeof d.lun === "number" ? d.lun : undefined,
    }));
  const agg = isObj(diskData.disk_metrics) && isObj(diskData.disk_metrics.aggregate)
    ? diskData.disk_metrics.aggregate
    : null;
  const metrics: DmcDiskMetrics | null = agg
    ? {
        readAvgKbps:  num(agg.read_avg_kbps),
        readP95Kbps:  num(agg.read_p95_kbps),
        writeAvgKbps: num(agg.write_avg_kbps),
        writeP95Kbps: num(agg.write_p95_kbps),
        readIops:     num(agg.read_iops),
        readIopsP95:  num(agg.read_iops_p95),
        writeIops:    num(agg.write_iops),
        writeIopsP95: num(agg.write_iops_p95),
      }
    : null;
  return { disks, metrics };
}

function parseNet(netData: unknown): DmcNetMetric | null {
  if (!isObj(netData)) return null;
  const agg = isObj(netData.metrics) && isObj(netData.metrics.aggregate)
    ? netData.metrics.aggregate
    : null;
  if (!agg) return null;
  return {
    receivedAvg:      num(agg["net.received.average"]),
    receivedP95:      num(agg["net.received.p95"]),
    receivedTotalGb:  num(agg["net.received.total_gb"]),
    transmittedAvg:   num(agg["net.transmitted.average"]),
    transmittedP95:   num(agg["net.transmitted.p95"]),
    transmittedTotalGb: num(agg["net.transmitted.total_gb"]),
    ipAddresses:      str(netData.ip_addresses),
  };
}

function parseCpu(cpu: unknown): DmcCpuMetric | null {
  if (!isObj(cpu)) return null;
  return {
    avg: num(cpu.metric_value),
    p95: num(cpu.metric_value_p95),
    peak: num(cpu.metric_value_peak),
    poweredOnHours: num(cpu.powered_on_hours),
    poweredOnPercent: num(cpu.powered_on_percent),
    dataPoints: num(cpu.data_points),
    collectionStart: str(cpu.collection_start_time),
    collectionEnd: str(cpu.collection_end_time),
  };
}

function parseMem(mem: unknown): DmcMemMetric | null {
  if (!isObj(mem)) return null;
  return {
    avg: num(mem.metric_value),
    p95: num(mem.metric_value_p95),
    dataPoints: num(mem.data_points),
  };
}

function parseVmFromMetric(
  vmName: string,
  vmUuid: string,
  subId: string,
  payload: Record<string, unknown>,
): DmcVm {
  const { disks, metrics: diskMetrics } = parseDisks(payload.disk_data);
  const collection = isObj(payload.metric_collection) ? payload.metric_collection : {};
  return {
    name: str(payload.server_name) || vmName,
    uuid: vmUuid,
    vmSize: str(payload.vm_size),
    cores: num(payload.number_of_cores),
    memoryMib: num(payload.memory),
    region: str(payload.azure_region),
    resourceGroup: str(payload.azure_resource_group),
    subscriptionId: subId,
    osType: str(payload.OSName, "Unknown"),
    powerState: asPower(payload.power_state),
    machineId: `${subId}-${str(payload.server_name) || vmName}`,
    cpu: parseCpu(payload.cpu),
    memory: parseMem(payload.memory_pct),
    net: parseNet(payload.network_data),
    disks,
    diskMetrics,
    collectionDays: num(collection.duration_days),
    granularityMinutes: num(collection.granularity_minutes),
  };
}

function parseVms(scanRoot: string, subId: string): DmcVm[] {
  const subDir = join(scanRoot, subId);
  if (!statSync(subDir).isDirectory()) {
    throw new Error(`Subscription dir not found: ${subDir}`);
  }
  const out: DmcVm[] = [];
  for (const vmUuid of readdirSync(subDir)) {
    const vmDir = join(subDir, vmUuid);
    if (!statSync(vmDir).isDirectory()) continue;
    const metricPath = join(vmDir, "metric-result.json");
    const metric = readJson(metricPath);
    if (!isObj(metric)) {
      throw new Error(`metric-result.json malformed for ${vmUuid}`);
    }
    const [vmName, payload] = Object.entries(metric)[0];
    if (!isObj(payload)) {
      throw new Error(`metric-result payload for ${vmName} is not an object`);
    }
    out.push(parseVmFromMetric(vmName, vmUuid, subId, payload));
  }
  // Stable order — by VM name — for deterministic output.
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function parseResourceCounts(raw: Record<string, unknown>): DmcResourceCounts {
  const summary = isObj(raw.resource_scan_summary) ? raw.resource_scan_summary : {};
  const results = isObj(summary.results) ? summary.results : {};
  const out: DmcResourceCounts = {};
  for (const [k, v] of Object.entries(results)) {
    if (isObj(v) && typeof v.count === "number") out[k] = v.count;
  }
  return out;
}

export function parseDmcScan(input: string): DmcScan {
  const scanRoot = findScanRoot(input);
  const { raw } = loadScanSummary(scanRoot);
  const meta = parseMeta(raw);
  if (!meta.scanId) throw new Error("Scan summary has no scan_id");
  if (!meta.subscriptionId) throw new Error("Scan summary has no subscription_id");
  return {
    meta,
    vms: parseVms(scanRoot, meta.subscriptionId),
    resourceCounts: parseResourceCounts(raw),
    rootPath: scanRoot,
  };
}
