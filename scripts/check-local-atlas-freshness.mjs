import { promises as fs } from "node:fs";
import path from "node:path";
import { renderAssets, OUTPUT_ROOT } from "./build-local-assets.mjs";
const expected=await renderAssets();
for(const [name,bytes] of Object.entries(expected)) {
  const actual=await fs.readFile(path.join(OUTPUT_ROOT,name));
  if(!actual.equals(bytes))throw new Error(`Stale generated asset: ${name}. Run pnpm assets:prepare.`);
}
console.log("Both pet formats match the current source and shared-camera renderer.");
