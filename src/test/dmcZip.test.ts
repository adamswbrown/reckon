import { describe, expect, test } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { extractDmcZip } from "../dmc/zip";
import { parseDmcScan } from "../dmc/parse";

const ZIP = resolve(__dirname, "..", "..", "test-fixtures", "contoso-dmc.zip");

describe("DMC zip extraction (password-protected)", () => {
  if (!existsSync(ZIP)) {
    test.skip("contoso-dmc.zip missing — run `cd test-fixtures && zip -P testpass123 -r contoso-dmc.zip dmc-azure-contoso/`", () => {});
    return;
  }

  test("extracts with the correct password and the parser ingests it", async () => {
    const out = await extractDmcZip(ZIP, "testpass123");
    try {
      const scan = parseDmcScan(out.scanRoot);
      expect(scan.meta.scanType).toBe("azure");
      expect(scan.vms.length).toBeGreaterThan(40);
    } finally {
      out.cleanup();
    }
  });

  test("rejects the wrong password with a clear error", async () => {
    await expect(extractDmcZip(ZIP, "definitely-wrong")).rejects.toThrow(/password did not decrypt/i);
  });
});
