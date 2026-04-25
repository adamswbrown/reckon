/**
 * Post-build steps for the Electron app:
 *   1. Drop a {"type":"commonjs"} package.json into dist-electron/ so Node
 *      treats the emitted .js files as CJS (the project root is "type":"module").
 *   2. Copy renderer static assets (index.html, styles.css) next to the
 *      compiled renderer.js.
 */

import { writeFileSync, copyFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const dist = resolve(root, "dist-electron");
const rendererDist = resolve(dist, "renderer");

mkdirSync(rendererDist, { recursive: true });

writeFileSync(
  resolve(dist, "package.json"),
  JSON.stringify({ type: "commonjs" }, null, 2) + "\n",
);

for (const f of ["index.html", "styles.css"]) {
  copyFileSync(resolve(root, "src/renderer", f), resolve(rendererDist, f));
}

console.log("post-build: wrote dist-electron/package.json and copied renderer assets");
