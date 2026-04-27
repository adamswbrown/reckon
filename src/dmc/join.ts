/**
 * Joins a DMC Azure-mode scan to a parsed Azure cost-export invoice.
 *
 * The join is canonical-resource-id based:
 *   /subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.Compute/virtualMachines/<vm>
 *
 * Output is a flat `JoinedVm[]` carrying utilisation (from DMC) and
 * billing reality (from the invoice, summed across compute, license,
 * disk, and bandwidth meters tied to the VM or its disks).
 *
 * The join is non-destructive: VMs without invoice rows still appear
 * (with `monthlyCost: 0`), and invoice rows that don't tie to any VM
 * are simply ignored — they're handled by the existing invoice
 * pipeline.
 */

import type { ParsedInvoice, InvoiceRow } from "../types";
import type { DmcScan, DmcVm } from "./types";

export interface JoinedVm {
  vm: DmcVm;
  /** Sum of every invoice row tied to this VM's resourceId or its disks. */
  monthlyCost: number;
  /** Compute-only cost (excludes disks + license uplift). Useful for sizing math. */
  computeCost: number;
  /** Windows / SQL license uplift visible on the invoice. */
  licenseCost: number;
  diskCost: number;
  bandwidthCost: number;
  currency: string;
  /** Invoice rows that contributed — preserved for evidence emission. */
  evidenceRows: InvoiceRow[];
  /** Period length in months (decimal). Use to convert raw row cost → monthly. */
  periodMonths: number;
}

const VM_RID_PREFIX = "/Microsoft.Compute/virtualMachines/";
const DISK_RID_PREFIX = "/Microsoft.Compute/disks/";

function vmKey(rid: string): string | null {
  const i = rid.indexOf(VM_RID_PREFIX);
  return i >= 0 ? rid.slice(i + VM_RID_PREFIX.length).toLowerCase() : null;
}

function diskOwnerVm(rid: string): string | null {
  const i = rid.indexOf(DISK_RID_PREFIX);
  if (i < 0) return null;
  const diskName = rid.slice(i + DISK_RID_PREFIX.length).toLowerCase();
  // Synthetic + real DMC convention: disks are named `<vm>-os` / `<vm>-data-NN` /
  // `<vm>-osdisk-<timestamp>`. Match on the first segment up to the first dash
  // followed by a known disk-role token.
  const m = diskName.match(/^(.+?)-(?:os|data|log|osdisk|datadisk)\b/);
  return m ? m[1] : diskName.split("-")[0];
}

function periodMonths(invoice: ParsedInvoice): number {
  const start = new Date(invoice.period.startDate).getTime();
  const end = new Date(invoice.period.endDate).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return 1;
  const days = (end - start) / 86_400_000 + 1;
  return Math.max(0.25, days / 30);
}

export function joinDmcWithInvoice(scan: DmcScan, invoice: ParsedInvoice): JoinedVm[] {
  const months = periodMonths(invoice);
  // Index VMs by lowercased name for the lookup.
  const byName = new Map<string, JoinedVm>();
  for (const vm of scan.vms) {
    byName.set(vm.name.toLowerCase(), {
      vm,
      monthlyCost: 0,
      computeCost: 0,
      licenseCost: 0,
      diskCost: 0,
      bandwidthCost: 0,
      currency: invoice.displayCurrency,
      evidenceRows: [],
      periodMonths: months,
    });
  }

  for (const row of invoice.rows) {
    const vmName = vmKey(row.resourceId);
    const diskOwner = vmName ? null : diskOwnerVm(row.resourceId);
    const target = byName.get((vmName ?? diskOwner ?? "").toLowerCase());
    if (!target) continue;
    target.evidenceRows.push(row);
    target.monthlyCost += row.cost;
    if (vmName) {
      if (/license/i.test(row.serviceName)) {
        target.licenseCost += row.cost;
      } else if (/bandwidth/i.test(row.serviceName)) {
        target.bandwidthCost += row.cost;
      } else {
        target.computeCost += row.cost;
      }
    } else if (diskOwner) {
      target.diskCost += row.cost;
    }
  }

  // Normalise period to monthly so later rule maths can reason in $/mo.
  for (const j of byName.values()) {
    j.monthlyCost = j.monthlyCost / months;
    j.computeCost = j.computeCost / months;
    j.licenseCost = j.licenseCost / months;
    j.diskCost = j.diskCost / months;
    j.bandwidthCost = j.bandwidthCost / months;
  }

  return [...byName.values()];
}
