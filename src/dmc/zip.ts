/**
 * Extracts a password-protected zip containing a DMC Azure-mode scan
 * to a private temp directory and returns the path the parser should
 * walk.
 *
 * Constraints:
 *   - Pure JS (node-stream-zip) — no shelling out, works the same on
 *     macOS / Windows / Linux when the app is packaged.
 *   - Supports legacy ZipCrypto encryption (the default for macOS
 *     Archive Utility, Windows built-in compression, 7-Zip with the
 *     "ZipCrypto" option). WinZip AES-128/256 is not supported by
 *     the underlying library — surface a clear error if it appears.
 *   - The temp directory is opaque to the caller; cleanup is the
 *     caller's responsibility (pass the returned path to `cleanup`).
 *
 * The parser is forgiving about scan-root depth: a zip whose top-level
 * is the scan dir (`<scan_id>/...`) and a zip whose top-level is the
 * scan dir's parent both work — `parseDmcScan` already traverses one
 * level deep to find the summary JSON.
 */

import { mkdtempSync, rmSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";

export interface ExtractedDmcZip {
  /** Directory the caller should pass to `parseDmcScan`. */
  scanRoot: string;
  /** Cleanup callback — caller invokes when finished with the data. */
  cleanup: () => void;
}

export async function extractDmcZip(
  zipPath: string,
  password: string,
): Promise<ExtractedDmcZip> {
  const st = statSync(zipPath);
  if (!st.isFile()) throw new Error(`Not a file: ${zipPath}`);

  const tempDir = mkdtempSync(join(tmpdir(), "reckon-dmc-"));
  let zip: AdmZip;
  try {
    zip = new AdmZip(zipPath);
  } catch (err) {
    rmSync(tempDir, { recursive: true, force: true });
    throw new Error(`Could not open zip: ${(err as Error).message}`);
  }

  // Validate password & detect AES (unsupported) entries before writing.
  const entries = zip.getEntries();
  const aesEntry = entries.find((e) => {
    // adm-zip exposes the encryption method via the central directory header
    // (method 99 = WinZip AES).
    const m = (e.header as { method?: number }).method;
    return m === 99;
  });
  if (aesEntry) {
    rmSync(tempDir, { recursive: true, force: true });
    throw new Error(
      "This archive uses WinZip AES encryption, which is not supported. " +
        "Re-create the zip using legacy / ZipCrypto encryption " +
        "(macOS Archive Utility, Windows built-in compression, or 7-Zip with " +
        "the 'ZipCrypto' option), then retry.",
    );
  }

  try {
    // Synchronous; adm-zip throws on bad password during data extraction.
    zip.extractAllTo(tempDir, /* overwrite */ true, /* keepOriginalPermission */ false, password);
  } catch (err) {
    rmSync(tempDir, { recursive: true, force: true });
    const msg = (err as Error)?.message ?? String(err);
    if (/password|incorrect|invalid|crc/i.test(msg)) {
      throw new Error("The password did not decrypt the archive. Check the password and try again.");
    }
    throw new Error(`Failed to extract DMC zip: ${msg}`);
  }

  const scanRoot = locateScanRoot(tempDir);
  return {
    scanRoot,
    cleanup: () => rmSync(tempDir, { recursive: true, force: true }),
  };
}

/**
 * Walk down at most two levels to locate a directory containing a
 * `<uuid>.json` summary file — the canonical DMC scan-root marker.
 */
function locateScanRoot(extractRoot: string): string {
  const isSummary = (name: string): boolean => /^[0-9a-f-]{36}\.json$/i.test(name);
  const probe = (dir: string): boolean => {
    try {
      return readdirSync(dir).some(isSummary);
    } catch {
      return false;
    }
  };
  if (probe(extractRoot)) return extractRoot;
  const top = readdirSync(extractRoot)
    .map((n) => join(extractRoot, n))
    .filter((p) => statSync(p).isDirectory());
  for (const d of top) {
    if (probe(d)) return d;
    // Single child wrapping (zip with extra wrapper dir).
    const inner = readdirSync(d)
      .map((n) => join(d, n))
      .filter((p) => statSync(p).isDirectory());
    for (const id of inner) {
      if (probe(id)) return id;
    }
  }
  throw new Error(
    "Extracted zip does not look like a DMC Azure-mode scan: no <scan-id>.json summary " +
      "file found at the top of the archive.",
  );
}
