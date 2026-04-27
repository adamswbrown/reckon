/**
 * Type model for a parsed DMC Azure-mode scan.
 *
 * Mirrors the on-disk shape produced by `dmc.exe azure ...` (and the
 * Intel Cloud Optimizer fork). The parser exposes a flat, normalised
 * view consumable by JJ's engine alongside the existing invoice flow.
 *
 * The cost layer is intentionally absent — these fixtures carry
 * utilisation and inventory only. JJ joins cost from the invoice (or
 * a SKU rate-table lookup) at analysis time.
 */

export type PowerState = "running" | "deallocated" | "stopped" | "unknown";

export interface DmcScanMeta {
  scanId: string;
  scanType: "azure";
  startTime: string;
  endTime: string;
  status: string;
  scanMode: string[];
  subscriptionId: string;
  subscriptionName: string;
  totalVms: number;
  completedVms: number;
  erroredVms: number;
  skippedVms: number;
  dmcVersion: string;
}

export interface DmcDisk {
  name: string;
  capacityGb: number;
  diskType: string;
  storageType: string | null;
  lun?: number;
}

export interface DmcDiskMetrics {
  readAvgKbps: number;
  readP95Kbps: number;
  writeAvgKbps: number;
  writeP95Kbps: number;
  readIops: number;
  readIopsP95: number;
  writeIops: number;
  writeIopsP95: number;
}

export interface DmcCpuMetric {
  avg: number;
  p95: number;
  peak: number;
  poweredOnHours: number;
  poweredOnPercent: number;
  dataPoints: number;
  collectionStart: string;
  collectionEnd: string;
}

export interface DmcMemMetric {
  avg: number;
  p95: number;
  dataPoints: number;
}

export interface DmcNetMetric {
  receivedAvg: number;
  receivedP95: number;
  receivedTotalGb: number;
  transmittedAvg: number;
  transmittedP95: number;
  transmittedTotalGb: number;
  ipAddresses: string;
}

export interface DmcVm {
  name: string;
  uuid: string;
  vmSize: string;
  cores: number;
  memoryMib: number;
  region: string;
  resourceGroup: string;
  subscriptionId: string;
  osType: string;
  powerState: PowerState;
  /** machine_id from DMC: "<sub>-<vm-name>" — stable join key. */
  machineId: string;
  cpu: DmcCpuMetric | null;
  memory: DmcMemMetric | null;
  net: DmcNetMetric | null;
  disks: DmcDisk[];
  diskMetrics: DmcDiskMetrics | null;
  collectionDays: number;
  granularityMinutes: number;
}

export interface DmcResourceCounts {
  /** Map of resource type → count. Mirrors `resource_scan_summary.results`. */
  [resourceType: string]: number;
}

export interface DmcScan {
  meta: DmcScanMeta;
  vms: DmcVm[];
  resourceCounts: DmcResourceCounts;
  /** Raw scan path for evidence resolution. */
  rootPath: string;
}
