/**
 * Locate a real Azure cost-export invoice on disk for integration tests
 * and the smoke script. The filename is never hardcoded — customer names
 * must not appear in this codebase.
 *
 * Resolution order:
 *   1. `RECKON_TEST_INVOICE` env var, if set and the file exists.
 *   2. The first `*.xlsx` in the current working directory.
 *   3. `null` — caller skips its work.
 *
 * Drop any Azure cost-analysis export into the project root and the
 * smoke script + integration tests pick it up automatically.
 */

import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

export function findTestInvoice(): string | null {
  const fromEnv = process.env.RECKON_TEST_INVOICE;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  const cwd = process.cwd();
  let entries: string[];
  try {
    entries = readdirSync(cwd);
  } catch {
    return null;
  }
  const xlsx = entries
    .filter((f) => f.toLowerCase().endsWith(".xlsx"))
    .filter((f) => !f.startsWith("~$")); // skip Excel lockfiles
  if (xlsx.length === 0) return null;

  // Rank by likelihood of being an Azure cost-analysis export. Common
  // names from the portal include "Cost analysis", "Detailed usage",
  // and "Invoice". We score each candidate; first non-zero wins.
  const POSITIVE = [
    /\binvoice\b/i,
    /\bcost\s*analysis\b/i,
    /\bdetailed\s*usage\b/i,
    /\bazure\s*cost\b/i,
  ];
  const NEGATIVE = [/\bfindings?\b/i, /\brecommendations?\b/i, /\breport\b/i];

  function score(name: string): number {
    let s = 0;
    for (const p of POSITIVE) if (p.test(name)) s += 10;
    for (const p of NEGATIVE) if (p.test(name)) s -= 5;
    return s;
  }

  const ranked = xlsx
    .map((f) => ({ f, s: score(f) }))
    .sort((a, b) => b.s - a.s || a.f.localeCompare(b.f));
  return resolve(cwd, ranked[0]!.f);
}
