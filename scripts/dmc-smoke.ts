/**
 * Smoke test: parse a DMC Azure-mode scan directory and print a summary.
 *
 *   tsx scripts/dmc-smoke.ts <scan-dir>
 *
 * Exits 0 on a parsed-and-summarised scan, non-zero on any error.
 */

import { resolve } from "node:path";
import { parseDmcScan } from "../src/dmc/parse";
import { summariseDmcScan } from "../src/dmc/summarise";

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function topMap(m: Map<string, number>, n: number): Array<[string, number]> {
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

function main() {
  const dir = process.argv[2] ?? "test-fixtures/dmc-azure-contoso";
  const scan = parseDmcScan(resolve(dir));
  const s = summariseDmcScan(scan);

  console.log("\nDMC Azure scan");
  console.log("─".repeat(60));
  console.log(`Scan ID         ${scan.meta.scanId}`);
  console.log(`Subscription    ${scan.meta.subscriptionId} (${scan.meta.subscriptionName || "—"})`);
  console.log(`Window          ${scan.meta.startTime} → ${scan.meta.endTime}`);
  console.log(`Modes           ${scan.meta.scanMode.join(", ")}`);
  console.log(`DMC version     ${scan.meta.dmcVersion}`);

  console.log(`\nVMs             ${s.totalVms} (${s.runningVms} running, ${s.deallocatedVms} deallocated)`);
  console.log(`Cores           ${s.totalCores}`);
  console.log(`Memory          ${s.totalMemoryGib} GiB`);
  console.log(`Disks           ${s.totalDisks} (${s.totalDiskTb} TiB)`);

  console.log("\nRegion mix");
  for (const [r, n] of topMap(s.byRegion, 5)) console.log(`  ${pad(r, 18)}${n}`);

  console.log("\nTop SKUs");
  for (const [k, n] of topMap(s.bySize, 6)) console.log(`  ${pad(k, 24)}${n}`);

  console.log("\nResource counts (top 10)");
  const rc = [...Object.entries(scan.resourceCounts)]
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  for (const [k, n] of rc) console.log(`  ${pad(k, 28)}${n}`);

  console.log(`\nDormant (${s.dormant.length})`);
  for (const d of s.dormant.slice(0, 8)) {
    console.log(`  ${pad(d.vm.name, 22)}${pad(d.reason, 22)}on ${d.poweredOnPercent.toFixed(1)}%`);
  }

  console.log(`\nRight-sizing candidates (${s.rightSizing.length})`);
  for (const r of s.rightSizing.slice(0, 10)) {
    console.log(`  ${pad(r.vm.name, 22)}${pad(r.vm.vmSize, 22)}cpu_p95=${r.cpuP95.toFixed(1)}%  mem_p95=${r.memP95.toFixed(1)}%  reason=${r.reason}`);
  }

  console.log(`\nReservation candidates (${s.reservationCandidates.length})`);
  for (const r of s.reservationCandidates.slice(0, 6)) {
    console.log(`  ${pad(r.vm.name, 22)}${pad(r.vm.vmSize, 22)}on=${r.poweredOnPercent.toFixed(1)}%  cpu_p95=${r.cpuP95.toFixed(1)}%`);
  }

  console.log();
}

main();
