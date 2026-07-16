import { promises as fs } from "node:fs";
import path from "node:path";
import { renderBlindDirectionSheet } from "./lib/blind-sheet.mjs";

let atlasPath;
let outputPath;
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  const value = process.argv[index + 1];
  if (!value) throw new Error(`${argument} requires a path.`);
  if (argument === "--atlas") atlasPath = path.resolve(value);
  else if (argument === "--output") outputPath = path.resolve(value);
  else throw new Error(`Unknown option: ${argument}`);
  index += 1;
}

if (!atlasPath || !outputPath) {
  throw new Error("Usage: node scripts/create-direction-blind-sheet.mjs --atlas <atlas> --output <sheet.png>");
}

const sheet = await renderBlindDirectionSheet(atlasPath);
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, sheet);
console.log(`Wrote deterministic blind-direction sheet: ${outputPath}`);
