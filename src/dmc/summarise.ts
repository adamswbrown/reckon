/**
 * First-pass analytics over a parsed DMC scan.
 *
 * Provides the workload-health signals JJ's invoice-only pipeline can't
 * generate: right-sizing candidates (CPU + memory headroom), dormant
 * detection (power_on_percent), reservation eligibility (steady-state
 * coverage). Pure functions — no rendering, no IO.
 */

import type { DmcScan, DmcVm } from "./types";

export interface RightSizingCandidate {
  vm: DmcVm;
  reason: "cpu-low" | "mem-low" | "both-low";
  cpuP95: number;
  memP95: number;
}

export interface DormantCandidate {
  vm: DmcVm;
  reason: "deallocated" | "powered-on-but-idle";
  poweredOnPercent: number;
  cpuPeak: number;
}

export interface ReservationCandidate {
  vm: DmcVm;
  poweredOnPercent: number;
  cpuP95: number;
}

export interface DmcSummary {
  totalVms: number;
  runningVms: number;
  deallocatedVms: number;
  totalCores: number;
  totalMemoryGib: number;
  totalDisks: number;
  totalDiskTb: number;
  byRegion: Map<string, number>;
  byTier: Map<string, number>;            // resource group → count
  bySize: Map<string, number>;            // SKU → count
  rightSizing: RightSizingCandidate[];
  dormant: DormantCandidate[];
  reservationCandidates: ReservationCandidate[];
}

const RIGHTSIZE_CPU_P95 = 20.0;     // %, below this → over-provisioned cores
const RIGHTSIZE_MEM_P95 = 50.0;     // %, below this → over-provisioned memory
const DORMANT_POWERED_ON = 5.0;     // %
const RESERVATION_POWERED_ON = 90.0; // % — steady-state threshold

function inc<K>(m: Map<K, number>, k: K, by = 1) {
  m.set(k, (m.get(k) ?? 0) + by);
}

export function summariseDmcScan(scan: DmcScan): DmcSummary {
  const byRegion = new Map<string, number>();
  const byTier = new Map<string, number>();
  const bySize = new Map<string, number>();
  const rightSizing: RightSizingCandidate[] = [];
  const dormant: DormantCandidate[] = [];
  const reservationCandidates: ReservationCandidate[] = [];

  let runningVms = 0;
  let deallocatedVms = 0;
  let totalCores = 0;
  let totalMemoryGib = 0;
  let totalDisks = 0;
  let totalDiskGb = 0;

  for (const vm of scan.vms) {
    inc(byRegion, vm.region);
    inc(byTier, vm.resourceGroup);
    inc(bySize, vm.vmSize);
    totalCores += vm.cores;
    totalMemoryGib += vm.memoryMib / 1024;
    totalDisks += vm.disks.length;
    totalDiskGb += vm.disks.reduce((s, d) => s + d.capacityGb, 0);

    if (vm.powerState === "running") runningVms++;
    if (vm.powerState === "deallocated") deallocatedVms++;

    if (!vm.cpu || !vm.memory) continue;

    const cpuP95 = vm.cpu.p95;
    const memP95 = vm.memory.p95;
    const poweredOn = vm.cpu.poweredOnPercent;

    if (vm.powerState === "deallocated") {
      dormant.push({ vm, reason: "deallocated", poweredOnPercent: poweredOn, cpuPeak: vm.cpu.peak });
    } else if (poweredOn < DORMANT_POWERED_ON) {
      dormant.push({ vm, reason: "powered-on-but-idle", poweredOnPercent: poweredOn, cpuPeak: vm.cpu.peak });
    } else {
      // Right-sizing candidates only count if VM is actually running enough
      // to trust the telemetry.
      if (cpuP95 < RIGHTSIZE_CPU_P95 && memP95 < RIGHTSIZE_MEM_P95) {
        rightSizing.push({ vm, reason: "both-low", cpuP95, memP95 });
      } else if (cpuP95 < RIGHTSIZE_CPU_P95) {
        rightSizing.push({ vm, reason: "cpu-low", cpuP95, memP95 });
      } else if (memP95 < RIGHTSIZE_MEM_P95 && cpuP95 < 35) {
        // Memory-low only counts as a candidate if CPU isn't already busy —
        // an E-series → D-series swap doesn't make sense for hot CPU.
        rightSizing.push({ vm, reason: "mem-low", cpuP95, memP95 });
      }

      if (poweredOn >= RESERVATION_POWERED_ON) {
        reservationCandidates.push({ vm, poweredOnPercent: poweredOn, cpuP95 });
      }
    }
  }

  // Stable, interpretable ordering: by p95 asc for right-sizing
  // (most over-provisioned first), by powered-on desc for reservations.
  rightSizing.sort((a, b) => a.cpuP95 - b.cpuP95);
  reservationCandidates.sort((a, b) => b.poweredOnPercent - a.poweredOnPercent);

  return {
    totalVms: scan.vms.length,
    runningVms,
    deallocatedVms,
    totalCores,
    totalMemoryGib: Math.round(totalMemoryGib * 10) / 10,
    totalDisks,
    totalDiskTb: Math.round((totalDiskGb / 1024) * 10) / 10,
    byRegion,
    byTier,
    bySize,
    rightSizing,
    dormant,
    reservationCandidates,
  };
}
